---
title: "NameLock을 사용하면서 고려해야 될 포인트(feat. 트랜잭션, 커넥션)"
date: 2026-03-23
categories: ["engineering"]
topics: ["탐구"]
description: "NameLock을 사용하면서 조심해야 될 포인트들을 탐구하는 글입니다."
featureimage: "../namedlock-1-img/img3.png"
draft: false
---
여러 락 기법 중에 DB락 중 하나인 네임드 락이 있습니다. 네임드 락은 특정 문자열에 락을 거는 방식으로 동작합니다.  
락 자체는 쉽지만 **획득/해제 과정**에서 정확히 알고 사용해야 되는 부분이 있었습니다.  
또한 [[우아한형제들] MySQL을 이용한 분산락으로 여러 서버에 걸친 동시성 관리](https://techblog.woowahan.com/2631/) 이 글을 읽으면서 궁금했던 부분이 있었는데 
직접 테스트해보며 비교해보려고 합니다.

---

# 1. NamedLock 락 획득/해제 과정
GET_LOCK(), RELEASE_LOCK() 함수를 사용하여 락 획득/해제를 합니다. 
이는 세션단위로 관리되어 락을 잡지않은 다른 세션은 대기하게 됩니다. 
![img1](../namedlock-1-img/img1.png)
공식문서에서 설명하듯이 트랜잭션 commit, rollback 으로 해제 되지 않습니다. 따라서 **세션 종료 또는 RELEASE_LOCK()** 을 통해 해제 해야 합니다.
```sql
/*
[GET_LOCK]
arg1, arg2 = 락 이름, 타임아웃 시간
return 
1 = 락 획득 성공
0 = 타임아웃 내 획득 실패
null = 에러
*/
SELECT GET_LOCK('lock1',10);
SELECT GET_LOCK('lock2',10);
/*
[RELEASE_LOCK]
return 
1 = 락 해제 성공 (자신이 소유한 락)
0 = 현재 세션이 그 락 소유자 아님
null = 락 존재하지 않음
*/
SELECT RELEASE_LOCK('lock2');
SELECT RELEASE_LOCK('lock1');
```
트랜잭션의 commit/rollback으로는 락 해제가 되지않으므로 따로 관리해야 될 것 같습니다.
하지만 @Transactional은 커넥션을 먼저 잡아서 해당 메서드 내에서는 동일한 커넥션으로 관리합니다.  
이어서 @Transactional과 함께 사용하는 방식에 대해 살펴보겠습니다. 

# 2. @Transactional 과 NamedLock을 함께 사용한다면
@Transactional과 사용할 때 내부에서 락을 관리하는 것과 밖에서 잡는 것의 차이점이 있습니다. 
먼저 @Transactional 내부에서 사용하는 방식을 확인해보겠습니다.
## @Transactional 내부에 NamedLock 사용
@Transactional 내부에서 NamedLock을 사용할 때는 락 커넥션과 비즈니스 커넥션이 모두 동일합니다.  
정말 그런지 @Transactional 내부에 NamedLock을 사용하는 케이스 테스트 해보았습니다. 
![img2](../namedlock-1-img/img2.png)
각 커넥션이 모두 57로 동일하다는 것을 확인하였습니다.
수도코드로 표현해보면 아래와 같은 방식으로 동작하기 때문입니다. 
```java
@Transactional
public void executeWithLock(){
	getLock(); // Connection A
	try {
		business(); // Connection A
	} finally {
		releaseLock(); // Connection A
	}
}

public void txProxy() {
	beginTransaction(); // 필요 시 Connection A를 트랜잭션에 바인딩
	try {
		executeWithLock();
		commit();
	} catch (Exception e) {
		rollback();
		throw e;
	} finally {
		cleanup(); // 세션/커넥션 정리 및 풀 반납
	}
}
```
하지만 이 방식에는 문제가 있습니다.   
RELEASE_LOCK()은 메서드 내부 finally에서 먼저 실행되고, 실제 commit 또는 rollback은 그 바깥의 트랜잭션 프록시에서 처리됩니다.  
즉 named lock의 해제 시점과 트랜잭션 종료 시점이 정확히 일치하지 않을 수 있습니다.  
이 경우 락은 이미 해제되었지만 트랜잭션은 아직 commit 또는 rollback 중인 상태가 될 수 있고, 그 사이 다른 세션이 동일한 named lock을 획득해 진입할 수 있습니다.    
결과적으로 named lock이 보호하려는 비즈니스 임계구역과 실제 데이터 확정 시점이 어긋나게 됩니다. 



## @Transactional 외부에 NamedLock 사용
그러면 @Transactional 외부에 NamedLock을 사용하면 어떨까요?
만약 아래처럼 사용한다면 주석처럼 락 획득과 해제시 사용하는 커넥션이 다를 수 있습니다.  
```java
public executeWithLock(){
	getLock(); // Connection A
	try {
		business(); // Connection B
	} finally {
		 releaseLock(); // Connection C
	}
}

@Transactional
public void business(){
	...
}
```
이를 동일한 커넥션으로 관리하려면 아래처럼 **직접 Connection 코드**를 작성하면 됩니다. 
```java
public void executeWithLock() {
    try (Connection conn = dataSource.getConnection()) {
        try {
            conn.setAutoCommit(false);

            getLock(conn);      // Connection A
            business();     // ??
            conn.commit();
        } catch (Exception e) {
            conn.rollback();
            throw e;
        } finally {
            releaseLock(conn);  // Connection A
        }
    }
}
```
여기서 business()를 **`??` 처리한 이유가 NamedLock과 같은 커넥션으로 관리할지 아니면 @Transactional과 같이 다른 커넥션으로 할지 고민했기 때문입니다.**  
business()가 다른 커넥션이라면 Lock 커넥션이 오류가 나도 정상적으로 처리되는 문제가 발생할 수 있지 않을까 싶습니다.

business()가 @Transactional을 이용한, 즉 다른 커넥션 일 때 상황을 가정하고 테스트해보았습니다.
business()는 한 개의 로우를 삽입하는 로직입니다.
![img3](../namedlock-1-img/img3.png)
Lock 커넥션 흐름에서 예외가 나왔을 때도 다른 커넥션인 business()는 정상적으로 커밋되었습니다.  
즉, 원자성이 보장되지 않는다는 것을 알 수 있습니다.


**우아한형제들 글의 초점**은 named lock을 동일한 커넥션에서 안전하게 획득/해제하는 데 있었습니다. 
그래서 **NamedLock + 비즈니스 로직의 원자성**에 대한 해결은 아래와 같이 생각해봤습니다. 

# 3. 해결책

```java
public void executeWithLock() {
	try (Connection conn = dataSource.getConnection()) {
		try {
			conn.setAutoCommit(false);

			getLock(conn);      // Connection A
			business(conn); // Connection A
			conn.commit();
		} catch (Exception e) {
			conn.rollback();
			throw e;
		} finally {
			releaseLock(conn);  // Connection A
		}
	}
}
```
business()도 Lock 커넥션과 같은 커넥션을 이용하는 방식으로 한다면 원자성을 보장하게 됩니다.  
이렇게 되면 트레이드 오프는 무엇이 있을지 생각해보았습니다.   
**가장 큰 차이는 business() 로직이 더 이상 JPA 영속성 컨텍스트의 관리를 받기 어렵다는 점입니다.**  
즉 @Transactional과 repository 중심의 고수준 개발 방식보다는, JDBC 기반으로 커넥션과 SQL을 직접 제어하는 저수준 방식에 가까워집니다.
왜냐면 만약 save() 이런 JPARepository 메서드는 conn을 사용하는 것이 아니라 자기 쪽에서 관리하는 영속성 컨텍스트/트랜잭션 자원에 연결된 커넥션을 사용하기 때문입니다.

---
## 느낀점 
NamedLock은 분산락으로 편하게 사용할 수 있지만 commit/rollback과 분리되어 관리해야되므로 트랜잭션과 함께 사용할 시 원자성에 대해 고민해야 했습니다.  
각 case별로 어떤 문제점이 있는지 알 수 있었고 다음으로는 JPA와 JDBC의 관계, 다른 분산락에 대해 더 자세히 알아봐야겠다는 생각이 들었습니다.

읽어주셔서 감사합니다.



