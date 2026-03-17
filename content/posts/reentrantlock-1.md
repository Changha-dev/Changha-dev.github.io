---
title: "왜 ReentrantLock은 pinning 이슈에서 자유로울까?"
date: 2026-03-16
categories: ["engineering"]
topics: ["탐구"]
description: "Reentrantlock은 Synchronized와 달리 가상스레드 pinning 상황에서 자유로운 이유를 살펴봅니다."
featureimage: "../reentrantlock-1-img/img2.png"
draft: false
---
이전 글 시리즈에서는 가상 스레드의 내부동작과 Synchronized의 소스코드를 살펴보면서 Lock 동작 시 pinning이 걸리는 이유를 살펴보았습니다.  
[가상 스레드 소스코드 파헤쳐보기](https://changha-dev.github.io/posts/virtual-thread-1/)  
[Synchronized의 Lock 원리 파헤치기](https://changha-dev.github.io/posts/synchronizer-1/)

pinning 이슈 해결책으로 synchronized 대신 ReentrantLock을 사용하라는 권장사항이 있습니다. (JDK 21~23 기준)  
![img1](../reentrantlock-1-img/img1.png)

그럼 왜 ReentrantLock은 괜찮은지 살펴보고자 합니다.  

먼저 synchronized는 JDK 21~23 기준에서 monitor 구간 내부에서 blocking이 발생하면 virtual thread가 carrier thread에서 분리되지 못해 pinning이 발생할 수 있습니다.
![img2](../reentrantlock-1-img/img2.png)
이 때문에 Virtual Thread1에서 IO Blocking을 하면 Carrier Thread도 고정되어 아무것도 하지 못하고 가상 스레드의 이점을 활용하지 못하게 됩니다.

## ReentrantLock의 동작 방식
![img3](../reentrantlock-1-img/img3.png)
개략적으로 위와 같은 구조로 이루어져있습니다.
AQS, LockSupport에 대해서도 등장하게 되는데요.  
**AQS**는 AbstractQueuedSynchronizer의 약자로 락, 세마포어와 같은 동기화 도구를 만들기 위한 프레임워크입니다.  
**LockSupport**는 스레드를 park/unpark하는 저수준 primitive 입니다.

그러면 ReentrantLock부터 lock 소스코드 내부를 살펴보면서 진행하겠습니다. 
### NonFairSync.lock()
```java
final void lock() {
            if (!initialTryLock())
                acquire(1);
}

public final void acquire(int arg) {
	if (!tryAcquire(arg))
		acquire(null, arg, false, false, false, 0L);
}
```
lock()을 하게되면 initialTryLock()을 호출 후 만약 false를 반환받는다면 acquire(1)메서드를 호출하는 흐름입니다.

_Sync를 상속하는 FairSync/NonFairSync가 있습니다.
이부분에 따라 로직이 조금 달라지는데 NonFairSync를 기준으로 진행 후 아래에서 설명하겠습니다._

### Sync.initialTryLock()
```java
final boolean initialTryLock() {
	Thread current = Thread.currentThread();
	if (compareAndSetState(0, 1)) { // state 0 : 락 비어있음, 1 : 락 잡혀있음
		setExclusiveOwnerThread(current);
		return true;
	} else if (getExclusiveOwnerThread() == current) {
		int c = getState() + 1;
		if (c < 0) // overflow
			throw new Error("Maximum lock count exceeded");
		setState(c);
		return true;
	} else
		return false;
}
```
현재 스레드를 파악하고 state에 따라 분기처리를 합니다. state == 0 인경우는 락이 비어있어서 CAS 연산 후
자신이 선점합니다. 만약 기존 락 소유자가 자기자신이었다면 재진입을 허용합니다.  
여기서 중요한 점은 currentThread()메서드를 통해 가상 스레드도 식별 가능하다는 점입니다.
![img4](../reentrantlock-1-img/img4.png)
mount 코드 내부를 보면 위와 같이 설정함으로서 가상 스레드와 매핑하는 것을 알 수 있습니다.

initialTryLock()이 lock 진입 직후의 빠른 1차 시도라면, tryAcquire()은 AQS 내부 루프에서 반복 호출되며 락 획득을 다시 시도하는 메서드입니다.
### tryAcquire()
```java
protected final boolean tryAcquire(int acquires) {
    if (getState() == 0 && compareAndSetState(0, acquires)) {
        setExclusiveOwnerThread(Thread.currentThread());
        return true;
    }
    return false;
}
```
현재 락이 비어있을 때 CAS연산을 통해 락 획득을 시도합니다. CAS에 성공하면 현재 스레드를 락 소유자로 설정하고 true를 반환합니다.
실패하면 false를 반환하며, 이후 AQS의 큐 대기 경로로 넘어가게 됩니다.

### AQS.acquire() 구현체
```java
final int acquire(Node node, int arg, boolean interruptible) {
    Thread current = Thread.currentThread();
    boolean interrupted = false;
    boolean first = false;
    Node pred = null;

    for (;;) {
        if (!first && (pred = (node == null) ? null : node.prev) != null) {
            first = (head == pred);
        }

        if (first || pred == null) {  // (1)
            if (tryAcquire(arg)) {
                if (first) {
                    node.prev = null;
                    head = node;
                    pred.next = null;
                    node.waiter = null;
                    if (interrupted) current.interrupt();
                }
                return 1;
            }
        }

        if (tail == null) { // (2)
            ...
        } else if (node == null) {
            ...
        } else if (pred == null) {
            ...
        } else if (node.status == 0) { // (3)
            node.status = WAITING;
        } else {
            LockSupport.park(this);
            node.clearStatus();
            if ((interrupted |= Thread.interrupted()) && interruptible) {
                break;
            }
        }
    }

    return cancelAcquire(node, interrupted, interruptible);
}
```
이해를 위해 AQS.acquire()의 핵심 흐름만 남겨 정리하면 다음과 같습니다. 먼저 (1)에서 앞줄이면 다시 락을 시도합니다.
(2) 실패했을 때 if ~ else if 문 들에서 큐에 들어갈 준비를 합니다. 큐를 초기화하거나, 노드를 만들고, tail 뒤에 붙이는 작업들입니다.
(3) WAITING 설정 후 다음 루프에서도 락 획득이 안되면 else 분기로 가서 park로 대기합니다.  
위 코드에서 LockSupport가 등장한 것을 알 수 있습니다.
> LockSupport의 park는 현재 스레드를 대기 상태로 전환하는 저수준 블로킹 primitive
### LockSupport.park()
```java
public static void park(Object blocker) {
	Thread t = Thread.currentThread();
	setBlocker(t, blocker);
	try {
		if (t.isVirtual()) {
			JLA.parkVirtualThread();
		} else {
			U.park(false, 0L);
		}
	} finally {
		setBlocker(t, null);
	}
}
```
try 문 안에서 isVirtual() 체크로 로직 분기 하는 것을 알 수 있습니다.  
**최종적으로는 LockSupport의 park메서드 내부에서 가상 스레드인지, 플랫폼 스레드인지 판단 후 분기 처리 하는 것입니다.** 

## FairSync/NonFairSync
두 개의 락 모두 AQS를 사용하며 대기 중인 스레드를 관리하기 위해 FIFO 대기 큐를 유지합니다. 
다만 차이점은 락을 획득하려는 시점입니다. NonFairSync는 큐에 대기 중인 스레드가 있더라도 새로 도착한 스레드가 즉시 락을 가로챌 수 있는 기회를 부여합니다. 
반면 FairSync는 새로 도착한 스레드가 있더라도 큐의 앞부분부터 순차적으로 락을 획득합니다.

그래서 FairSync 메서드들을 보면 락 획득 시 
```java

final boolean initialTryLock() {
    ...
	if (c == 0) {
		if (!hasQueuedThreads() && compareAndSetState(0, 1)) {
            ...
		}
	} 
    ...
}

protected final boolean tryAcquire(int acquires) {
            if (getState() == 0 && !hasQueuedPredecessors() &&
                compareAndSetState(0, acquires)) {
                ...
            }
            ...
        }
```
hasQueuedPredecessors()가 항상 같이 있는 것을 확인할 수 있습니다.

NonFair방식이 즉시 락을 사용할 때 즉시 스레드가 사용되어 전환 비용이 감소한다는 장점이 있습니다. 
반면 Fair방식은 대기 스레드를 실행 상태로 변경하는 오버헤드가 발생합니다.
그렇다고 NonFair방식이 항상 좋은 건 아닙니다. 계속해서 새로운 스레드가 락을 가지게 된다면 기아상태에 빠질 수 있는 위험이 있습니다.

---

핵심은 ReentrantLock의 대기 과정이 Object Monitor 기반이 아니라, virtual thread를 인식하는 LockSupport.park() 경로 위에서 동작한다는 점입니다. 
따라서 JDK 21~23 기준에서는 synchronized에서 문제가 되는 pinning 상황을 피하는 데 더 유리합니다.
