---
title: "분산환경에서의 배치 스케줄링 아키텍처 설계 및 비교"
date: 2026-03-07
categories: ["engineering"]
topics: ["나르지지", "탐구"]
description: "스케줄링을 통한 배치 API콜을 분산환경에서는 어떻게 관리해야 될 지 알아보는 글입니다."
featureimage: "../distribute-batch-architecture-img/img7.png"
draft: false
---
현재 나르지지 서비스는 스케줄링을 통한 배치 API 요청을 주기적으로 하고 있습니다.(6시간 단위)  
현재는 단일 서버라서 괜찮지만 만약 멀티 인스턴스 구조로 서비스 운영을 한다면 다중 스케줄링이 작동하게 될 것 입니다.  
이는 다양한 충돌 오류 상황을 만들 수 있는 가능성이 있어서 방지하고자 다양한 설계 방안을 생각해보고 장단점을 알아보겠습니다.  

목적은 하나의 서버에서만 배치 API를 실행하여 완료하는 것입니다. 

# 1. API 요청을 딱 한 번, 한 서버에 쏘도록 하면 어떨까
직관적으로 떠올릴 수 있는 방식입니다. scheduler를 외부로 분리하여 특정시간에 한 번의 API 요청을 실행하도록 합니다. 
그러면 N개의 서버 중 1개가 받아서 그 곳에서 배치를 처리할 것 입니다. 
## Solution 1
![img1](../distribute-batch-architecture-img/img1.png)
AWS EC2 인스턴스를 활용하고 있기에 이를 가능하게 하는 서비스들을 살펴보았습니다.
- EventBridge Scheduler
- ALB (Application Load Balancer)

### EventBridge Scheduler
위 서비스를 활용하면 API 요청을 예약하여 진행할 수 있습니다. 
다만 여기서 확인해야될 것이 **정확히 한 번** API 요청을 보장하느냐입니다. 
![img2](../distribute-batch-architecture-img/img2.png)
공식 문서에서 설명하듯이 **최소 한 번** 메커니즘으로 동작합니다.  
API 응답을 타임아웃 안에 받지 못했을 때 또는 5xx와 같은 오류코드를 받았을 때 다시 API 요청을 보내는 방식입니다.

### ALB
ALB는 어플리케이션단 로드밸런서 역할을 합니다.  
ALB는 주기적으로 healthcheck를 하는데 healthy한 서버들 중 로드밸런 알고리즘에 따라 API 요청을 보냅니다.  
AWS에서 제공하는 것은 **Round Robin(RR)**, **Least Outstanding Requests(LOR)** 이렇게 두 개가 있습니다.
RR은 요청을 서버들 돌아가면서 균등하게 요청하는 방식이고 LOR은  미처리 요청이 가장 적은 서버로 요청을 보내는 방식입니다.

## 한계점
여기까지 살펴봤을 때 제가 원하는 건 API 요청을 딱 한 번, 한 서버에서만 배치 서비스를 안전히 완료하는 것입니다.
하지만 Scheduler와 ALB 조합으로 했을 때 ALB측에서 요청을 정상적으로 받았지만 응답을 보내는 과정에서 타임아웃과 같은 이유로
5xx 에러를 반환한다면 Scheduler는 재시도 전략을 통해 API 요청을 중복해서 보내게 된다는 한계가 있습니다.  
또한 ALB <-> Server 에서의 재시도가 어렵습니다. 서버에서 배치를 진행하다가 종료된다면 스스로 재시도를 할 수는 없기에 이를 관리해주는 곳이 
없기 때문입니다.

## Solution 2 
![img3](../distribute-batch-architecture-img/img3.png)
이 방식은 SQS 방식을 통해 메시지를 하나의 서버에서만 소비하도록 하는 방식입니다.  
아래의 설명처럼 SQS의 FIFO 방식을 이용하면 같은 메시지가 큐에 중복으로 들어가는 것을 줄여줍니다. 
![img4](../distribute-batch-architecture-img/img4.png)

EventBridge Scheduler에서 SQS 파라미터로 content-based, 즉 body에 변하지 않는 값의 조합으로 설정을 하면
재시도를 통해 API를 다시 보내더라도 SQS에서 걸러지게 될 것 입니다.
``` 
runId = jobName "|" + scheduledTimeSlot

jobName : 스케줄 종류 구분
scheduledTimeSlot : 스케줄 지정 시간
```
이런식으로 멱등키를 설계할 수 있을 것 같습니다.
주의해야 될 점이 body에 재시도에도 변하지 않는 값만 넣어야 SQS에서 중복을 제대로 걸러낼 수 있습니다.
![img5](../distribute-batch-architecture-img/img5.png)

여기까지 했을 때 Scheduler <-> SQS의 중복 메시지는 해결되었습니다.  
다만 SQS -> Server 로의 과정에서는 문제점이 남아있습니다. 
SQS는 메시지를 Server로 보내고 곧바로 삭제하는 것이 아니라 DeleteMessage를 호출해야 삭제 됩니다. 
그 전에는 Visibility Timeout 시간동안 감춰지게 됩니다.

## Problem
![img6](../distribute-batch-architecture-img/img6.png)
멱등성을 위해 다른 서버에서 배치 상태를 확인했을 때 Running이라면 Skip하는 식으로 로직을 설계할 수 있습니다.  
하지만 위처럼 배치 담당 서버가 갑자기 죽게된다면 다른 서버에서 받아도 계속해서 Skip만 하게 되는 문제가 발생할 것 입니다.  
만약 다른 서버에서 계속되는 Skip을 막기위해 DeleteMessage를 한다면 어떨까요?  
메시지 유실이 일어나서 해당 시간의 배치 API 요청이 사라질 수 있습니다.

### 배치 담당 서버가 정상적으로 동작하는지 확인할 수 있다면?
위와 같은 문제를 막기 위해서는 배치 담당 서버가 정상적으로 요청을 수행중인지 확인할 수 있으면 될 것 같습니다.  
서버들이 공유하는 멱등성 상태 DB를 기반으로 체크하면 되지 않을까 싶습니다.    
즉, 다음과 같은 시퀀스 흐름을 그려볼 수 있겠습니다.
![img7](../distribute-batch-architecture-img/img7.png)
Case1처럼 만약 Server1에서 배치 API를 정상적으로 진행하고 있으면 leaseUntil을 현재시간 + α로 연장합니다.
그리고 SQS에 ChangeMessageVisibility를 보내어 Visibility 시간도 연장합니다. (배치가 정상적으로 실행중일 때 재전송 발생 사전 방지)
이 때 SQS의 Visibility Timeout을 초과한다면 Case2가 발생할 수 있습니다. 
다른 서버에서 재시도 요청을 받는 경우입니다. 만약 RUNNING 이더라도 now > leaseUntil 이면 실행자가 중단되었다고 보고 본인이 배치 API를 해결합니다.
반면 아직 leaseUntil을 넘지 않았다면 Skip 하도록 합니다. 왜냐면 아직 Server1에서 처리중일 수 있기 때문입니다.

# ALB, SQS 방식 공통점
ALB 방식과 SQS 방식 모두, 멱등성을 적용하지 않으면 중복 트리거가 발생할 때 배치가 중복 실행될 수 있습니다.  
ALB 방식은 Scheduler의 재시도로 동일 HTTP 요청이 여러 번 ALB에 전달될 수 있고, ALB는 이를 여러 서버로 분산할 수 있습니다.  
SQS 방식은 FIFO가 중복 enqueue를 줄여주지만, Visibility Timeout/워커 장애로 메시지가 재전달될 수 있습니다.   
결국 최종적으로는 두 방식 모두 멱등성을 적용해야 된다는 공통점이 있습니다.  
멱등성을 통해 동일한 배치 API 요청에 다시 실행하는 것을 막을 수 있지만 더 나아가 해당 배치 담당 서버가 죽었는지 살았는지를 판단하고,
살아있으면 스킵 or 죽었으면 내가 처리하기와 같은 로직 설계를 해야했습니다. 
이것은 leaseUntil을 통한 비교로 해결할 수 있었습니다.  
이부분이 결국은 분산락 개념인 것을 파악하였는데.. 분산락에 대해서는 아직 깊이가 얕아 한번 다음에 알아보겠습니다.
