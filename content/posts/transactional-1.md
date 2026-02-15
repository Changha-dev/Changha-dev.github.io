---
title: "@Transactional은 어떻게 동작하는걸까?"
date: 2026-02-15
categories: ["engineering"]
topics: ["탐구"]
description: "토비의 스프링 책을 읽고 직접 @Transactional의 동작 원리를 파헤쳐보는 글입니다."
draft: false
---

프로젝트를 하다보면 @Transactional을 자주 쓰게 됩니다. 근데 이게 내부적으로 어떻게 동작하는지는 몰랐습니다.
그냥 마법처럼 스프링에서 관리해주는 어노테이션이라고 막연하게만 생각했습니다.

사용하기는 너무 쉽습니다. 트랜잭션이 필요한 곳에 메서드나 클래스에 @Transactional을 추가하면 됩니다.  
근데 막상 설명하려면 제대로 설명하기가 어렵습니다.

그래서 이번 기회에 한번 @Transactional이 어떻게 동작하는지, 그리고 왜 이렇게 동작하는지를 알아보려고 합니다.


일단 이것을 왜 사용해야되는지를 알아야 합니다.  

먼저 트랜잭션의 사용이유를 알아보겠습니다.

트랜잭션이란 All or Nothing 원칙으로 작동합니다.

즉, 하나의 논리적 작업 단위에 포함된 모든 연산이 성공하면 커밋(Commit)하고, 하나라도 실패하면 모든 작업을 롤백(Rollback)하여 이전 상태로 되돌립니다.



스프링에서 트랜잭션을 어떤식으로 구현하는 지 예시를 통해 확인해보겠습니다.

## 예시1 - 트랜잭션 로직 + 비즈니스 로직 
```java
public class UserService {
    private UserDao userDao;
    private PlatformTransactionManager transactionManager;
    
    public void upgradeLevels() {
        // ========== 트랜잭션 시작 ==========
        TransactionStatus status = 
            this.transactionManager.getTransaction(new DefaultTransactionDefinition());
        
        try {
            // ========== 비즈니스 로직 시작 ==========
            List<User> users = userDao.getAll();
            for(User user : users) {
                if(canUpgradeLevel(user)) {
                    upgradeLevel(user);
                }
            }
            // ========== 비즈니스 로직 끝 ==========
            
            // ========== 성공시 커밋 ==========
            this.transactionManager.commit(status);
        } catch (RuntimeException e) {
            // ========== 실패시 롤백 ==========
            this.transactionManager.rollback(status);
            throw e;
        }
        // ========== 트랜잭션 끝 ==========
    }
}
```
위처럼 순수 구현으로 했을 때 try 문 안에 비즈니스 코드가 있는 것을 알 수 있습니다.

그 외는 트랜잭션 코드입니다.

여기서는 하나의 메서드만 있어서 망정이지 downgradeLevels와 같은 메서드나 새로운 메서드가 들어오면
트랜잭션 코드의 중복이 발생 할 것이 분명합니다.

이를 해결하기 위해 두번째 방식은 트랜잭션을 UserService에서 안보이게 분리하는 것입니다.

## 예시2 - DI 방식으로 트랜잭션 코드 분리
```java 
public interface UserService {
    void upgradeLevels();
}

public class UserServiceImpl implements UserService {
    private UserDao userDao;
    
    public void upgradeLevels() {
        // 순수 비즈니스 로직만
        List<User> users = userDao.getAll();
        for(User user : users) {
            if(canUpgradeLevel(user)) {
                upgradeLevel(user);
            }
        }
    }
}

public class UserServiceTx implements UserService {
    private UserService userService;  // 실제 로직 위임
    private PlatformTransactionManager transactionManager;
    
    public void upgradeLevels() {
        TransactionStatus status = transactionManager.getTransaction(new DefaultTransactionDefinition());
        try {
            userService.upgradeLevels();  // 위임
            transactionManager.commit(status);
        } catch (Exception e) {
            transactionManager.rollback(status);
            throw e;
        }
    }
}

//클라이언트에서 아래와 같이 사용 

UserService basic = new UserServiceImpl();
UserService withTx = new UserServiceTx(basic);
```

클라이언트 → UserServiceTx → UserServiceImpl (트랜잭션) (비즈니스 로직)

이렇게 하니까 UserServiceImpl에서 순수 비즈니스 로직만 작성할 수 있게 됐습니다.

하지만... 여기서도 단점이 있습니다. 무엇일까요?

두가지가 있습니다.

1. 일일이 구현하고 위임하는 코드를 작성해야한다는 것(인터페이스를 구현해야 하므로 트랜잭션이 필요없는 메서드도 다 만들어야하는 번거로움)

2. 트랜잭션 적용된 메서드가 많아질수록 중복되는 점(UserServiceTx에서 메서드가 추가될수록 try-catch문이 또 계속 반복되는 것)



이런 상황에서 스프링은 어떤 해결책을 가졌을까요?

바로 다이나믹 프록시입니다.

프록시란?
1. 타깃과 동일한 인터페이스
2. 클라 - 타깃 사이에 존재
3. 기능의 부가 or 접근 제어 담당

1,2,3번을 만족하는 녀석을 말합니다.

이것을 다이나믹하다니까 즉 런타임시 만들어진다고 볼 수 있겠습니다.

```java
// JDK 동적 프록시 생성 예시
UserService proxy = (UserService) Proxy.newProxyInstance(
    UserService.class.getClassLoader(), // 다이나믹 프록시가 정의되는 클래스 로더
    new Class[]{UserService.class}, // 구현해야 할 인터페이스
    new TransactionHandler(target) //부가기능과 위임 관련 코드
);
```
다이나믹 프록시 트랜잭션 테스트 

```java
@Test
public void dynamicProxyTransactionTest() {
    // given
    UserServiceImpl userServiceImpl = new UserServiceImpl();
    userServiceImpl.setUserDao(userDao);
    
    // 트랜잭션핸들러 생성에 필요한 DI 작업
    TransactionHandler txHandler = new TransactionHandler();
    txHandler.setTarget(userServiceImpl);
    txHandler.setTransactionManager(transactionManager);
    txHandler.setPattern("upgradeLevels");
    
    // when - 다이나믹 프록시 생성
    UserService txUserService = (UserService) Proxy.newProxyInstance(
        getClass().getClassLoader(),
        new Class[]{UserService.class},
        txHandler
    );
    
    // then - 트랜잭션이 적용된 메서드 실행
    txUserService.upgradeLevels();
    
    // 트랜잭션이 정상적으로 적용되었는지 검증
    List<User> users = userDao.getAll();
    checkLevelUpgraded(users.get(0), false);
    checkLevelUpgraded(users.get(1), true);
}
```
위와 같은 식으로 코드를 작성할 수 있습니다.
하지만 항상 트랜잭션을 위해 저렇게 작성하면 말짱 도루묵이니까
스프링에서 자동주입하도록 만들어야할 차례입니다.

근데... 문제는 다이나믹 프록시 오브젝트는 일반적인 스프링의 빈으로 등록될 방법이 없습니다.

```java
// 이런 식으로 할 수 없음 - 클래스가 없으니까!
@Bean
public ??? dynamicProxy() {
    return new ???();  // 뭘 new 할지 모름
}
```
그래서 등장한 것이 팩토리 빈입니다. 

## 예시3 - 다이나믹 프록시 + 팩토리 빈 방식
```java
@Component
public class TxProxyFactoryBean implements FactoryBean<Object> {
    private final Object target;
    private final PlatformTransactionManager transactionManager;
    private final String pattern;
    private final Class<?> serviceInterface;
    
    public TxProxyFactoryBean(
            @Qualifier("userServiceImpl") Object target,
            PlatformTransactionManager transactionManager) {
        this.target = target;
        this.transactionManager = transactionManager;
        this.pattern = "upgradeLevels";
        this.serviceInterface = UserService.class;
    }
    
    // 이부분이 우리가 해결하고자 하는 부분
    @Override
    public Object getObject() throws Exception {
        TransactionHandler txHandler = new TransactionHandler();
        txHandler.setTarget(target);
        txHandler.setTransactionManager(transactionManager);
        txHandler.setPattern(pattern);
        
        return Proxy.newProxyInstance(
            getClass().getClassLoader(),
            new Class[]{serviceInterface},
            txHandler
        );
    }
    
    @Override
    public Class<?> getObjectType() {
        return serviceInterface;
    }
    
    @Override
    public boolean isSingleton() {
        return false;
    }
}
```
팩토리 빈 방식

여기까지 오니까 꽤 힘듭니다. 

호흡을 가다듬고 중간정리 해보겠습니다. 



아까 트랜잭션 로직과 비즈니스 로직 분리를 위해 DI 방식으로 했습니다.

근데 이 과정에서 어떤 문제점이 있었나?

1. 일일이 구현하고 위임하는 코드를 작성해야한다는 것(인터페이스를 구현해야 하므로 트랜잭션이 필요없는 메서드도 다 만들어야됨)
2. 트랜잭션 적용된 메서드가 많아질수록 중복되는 점(UserServiceTx에서 메서드가 추가될수록 try-catch문이 또 계속 반복되는 것)


이것을 해결하기 위해 다이나믹 프록시가 나오게 되었습니다.

아까 다이나믹 프록시에 대해 보충 설명하자면 

![img1](../transactional-1-img/img1.png)

다른 클래스 예시지만 동작원리는 위와 동일합니다.
위 그림처럼 InvocationHandler의 invoke를 통해 모든 메서드를 구현한 오브젝트를 생성해줍니다.

이는 리플렉션 기능과 관련이 있는데 자세한 사항은 나중에 한번 다뤄보겠습니다.

하지만 다이나믹 프록시의 문제점이 스프링에서 관리해줄 수 없다는 것이었습니다.

왜냐면 동적으로 생성돼서 어떤 클래스인지 스프링의 작동시점에 정확히 모르기 때문입니다.

그래서 우회하는 방법으로 팩토리 빈을 통하여 다이나믹 프록시를 생성하였습니다.
여기까지와서 위의 문제점을 모두 해결하였습니다.



근데... 또 다른 서비스가 등장한다면 어떻게 될까요?
```java
// 서비스마다 일일이 팩토리 빈 설정 필요
@Bean
public TxProxyFactoryBean userService() {
    TxProxyFactoryBean factoryBean = new TxProxyFactoryBean();
    factoryBean.setTarget(userServiceImpl());
    factoryBean.setTransactionManager(transactionManager());
    factoryBean.setPattern("upgradeLevels");
    factoryBean.setServiceInterface(UserService.class);
    return factoryBean;
}

@Bean  
public TxProxyFactoryBean productService() {
    // 또 다른 팩토리 빈 설정...
}
```
이렇게 코드의 중복은 다시 생겨날 것입니다.

하나의 서비스에 다른 부가기능을 붙일때도 문제일 것입니다.

결국 코드의 양이 방대해져서 대규모 서비스에서는 유지보수하기 힘들어질 것이 자명합니다. 

### TransactionalHandler의 중복을 없애고 모든 타깃에 적용 가능한 싱글톤 빈으로 만들어서 적용할 수는 없을까?

있습니다. 프록시 팩토리 빈을 활용하면 됩니다.

스프링의 ProxyFactoryBean을 사용하여 프록시 생성을 추상화할 수 있습니다.

이것의 장점은 부가기능의 재사용성입니다. 하나의 Advice를 여러 타깃에 적용할 수 있습니다.

이것을 이해하려면 총 세가지의 개념을 알아야합니다. (여기서는 어떻게 동작하는지가 목표이므로 각각의 세부 코드는 생략하겠습니다.)

1. Advice : 순수 부가기능(ex. 트랜잭션 기능, 보안 기능)
2. Pointcut : 메서드 선정 알고리즘(어디에 적용을 할 것 인지)
3. Advisor : Advice + Pointcut

## 예시4 - 프록시 팩토리 빈 방식
```java
@Bean
public ProxyFactoryBean userService() {
    ProxyFactoryBean pfb = new ProxyFactoryBean();
    pfb.setTarget(userServiceImpl());
    
    // Pointcut 설정
    NameMatchMethodPointcut pointcut = new NameMatchMethodPointcut();
    pointcut.setMappedName("upgrade*");
    
    // Advisor = Advice + Pointcut
    DefaultPointcutAdvisor advisor = new DefaultPointcutAdvisor(pointcut, transactionAdvice());
    pfb.addAdvisor(advisor);
    
    return pfb;
}
```
만약 또다른 기능이 필요하다면 addAdvisor에 추가만 하면 끝입니다.

![img2](../transactional-1-img/img2.png)

프록시 팩토리 빈 동작 원리

![img3](../transactional-1-img/img3.png)

프록시 팩토리빈 적용 구조

| 구분 | 직접 팩토리 빈 | ProxyFactoryBean | 핵심 개념 | 요약 |
| --- | --- | --- | --- | --- |
| 부가기능 재사용 | 불가능 | 가능 | Advice | 부가기능을 분리해 여러 타깃에 재사용 가능 |
| 적용 대상 선별 | 하드코딩 | 가능 | Pointcut | 메서드/대상을 규칙으로 선별 가능 |
| 프록시 기술 선택 | 수동 | 자동 | JDK/CGLIB | 인터페이스 여부에 따라 자동 선택 |

이제 간단히 서비스별로 부가기능을 적용하는 코드를 완성하였습니다!

그럼 끝일까요..?

아닙니다.

저 간단한 코드도 새로운 서비스가 생길때마다 등록해야됩니다.

그러면 결국 코드의 양이 줄어드는건 아닌 것입니다.....

어떻게 해야 할까요?

이제 거의 다 왔습니다.

마지막 단계인 빈 후처리기를 이용하여 해결합니다.

빈 후처리기가 빈으로 등록되어있으면 빈 오브젝트가 생성될 때마다 빈 후처리기에 보내서 후처리 작업을 요청합니다. (모든 빈이 검토됩니다. 빈 후처리기에 의해)

즉 이것을 이용해 자동으로 프록시 적용을 할 수 있다는 것입니다.

![img4](../transactional-1-img/img4.png)

빈 후처리기를 이용한 동작 과정

## 예제5 - 빈 후처리기를 이용한 방식 

```java
@Configuration
public class AppConfig {

    // 1. 자동 프록시 생성기 - 딱 한 번만 등록
    @Bean
    public DefaultAdvisorAutoProxyCreator autoProxyCreator() {
        return new DefaultAdvisorAutoProxyCreator();
    }

    // 2. Advice - 부가기능
    @Bean
    public TransactionAdvice transactionAdvice() {
        TransactionAdvice advice = new TransactionAdvice();
        advice.setTransactionManager(transactionManager());
        return advice;
    }

    // 3. Advisor - Advice + Pointcut
    @Bean
    public DefaultPointcutAdvisor transactionAdvisor() {
        NameMatchMethodPointcut pointcut = new NameMatchMethodPointcut();
        pointcut.setMappedName("upgrade*");  // upgrade로 시작하는 메서드만
        return new DefaultPointcutAdvisor(pointcut, transactionAdvice());
    }

    // 4. 일반 빈 등록 - 자동으로 프록시 적용됨
    @Bean
    public UserService userService() {
        return new UserServiceImpl();  // upgrade* 메서드 있으면 자동 프록시
    }
    
    @Bean
    public ProductService productService() {
        return new ProductServiceImpl();  // upgrade* 메서드 없으면 프록시 안됨
    }
}
```

빈 후처리기가 빈으로 등록되어있으면

모든 등록된 어드바이저 내의 포인트컷을 이용해 전달받은 빈이 프록시 적용대상인지 확인합니다.

이제 일일이 프록시 팩토리 빈을 등록하지 않아도 타깃 오브젝트에 자동으로 프록시가 적용되게 할 수 있습니다.

그럼 대망의 @Transactional을 알아보겠습니다.

우리가 필요한 메서드에
```java
// 이제 이것만 하면 끝!
@Service
@Transactional
public class UserServiceImpl implements UserService {
    public void upgradeLevels() {
        // 순수 비즈니스 로직만
        List<User> users = userDao.getAll();
        for(User user : users) {
            if(canUpgradeLevel(user)) {
                upgradeLevel(user);
            }
        }
    }
}
```
이렇게만 하면 끝이 납니다.

내부에서는 
```java
// 스프링이 내부적으로 이런 설정을 자동으로 해줌
@EnableTransactionManagement  // 이 어노테이션이 핵심!
public class AppConfig {
    // 내부적으로 이런 빈들이 자동 등록됨:
    // - AnnotationTransactionAttributeSource (어노테이션 파싱)
    // - TransactionInterceptor (Advice 역할)
    // - BeanFactoryTransactionAttributeSourceAdvisor (Advisor 역할)
    // - InfrastructureAdvisorAutoProxyCreator (빈 후처리기 역할)
}
```
위와 같은 일들이 벌어집니다.
다 우리가 살펴본 동작들입니다.

![img5](../transactional-1-img/img5.png)

Pointcut 역할 : TransactionalAttributeSourcePointcut

@Transactional이 있는 메서드/클래스를 선별하는 역할
AnnotationTransactionAttributeSource를 활용하여 대상 판별
Advice 역할 : TransactionInterceptor

실제 트랜잭션 시작/커밋/롤백 처리
AnnotationTransactionAttributeSource에서 받은 속성으로 트랜잭션 관리
속성 제공자 : AnnotationTransactionalAttributeSource

포인트컷과 어드바이스가 참조하는 정보 제공자
어노테이션 파싱 및 속성 추출 전담


정리하자면 지금까지 우리의 여정은 다음과 같습니다.

1단계: 트랜잭션 + 비즈니스 로직 혼재

2단계: DI로 분리 (UserServiceTx)

3단계: 다이나믹 프록시 + 팩토리 빈

4단계: 프록시 팩토리 빈 (ProxyFactoryBean + Advice/Pointcut)

5단계: 빈 후처리기 (DefaultAdvisorAutoProxyCreator)

6단계: @Transactional ← 최종 완성!


## 느낀점
개인 프로젝트에 메서드 성능 측정용으로 어노테이션 만들어보고 싶다는 생각이 들어 간단히 만들어 보았습니다.

AOP방식으로 포인트컷, 어드바이스를 활용해서 성능 측정 어노테이션을 만들었습니다. 

```java
// 어노테이션 인터페이스 
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface PerformanceTimer {
    String value() default "";
}

// 성능측정용 빈
@Slf4j
@Aspect
@Component
public class PerformanceAspect {

    @Pointcut("@annotation(com.tools.seoultech.timoproject.global.annotation.PerformanceTimer)")
    private void performanceTimer() {}

    @Around("performanceTimer()")
    public Object measureExecutionTime(ProceedingJoinPoint joinPoint) throws Throwable {
        StopWatch stopWatch = new StopWatch();
        stopWatch.start();

        try {
            Object result = joinPoint.proceed(); // 실제 메서드 실행
            return result;
        } finally {
            stopWatch.stop();
            long totalTimeMillis = stopWatch.getTotalTimeMillis();

            MethodSignature signature = (MethodSignature) joinPoint.getSignature();
            String methodName = signature.getMethod().getName();
            String className = joinPoint.getTarget().getClass().getSimpleName();

            log.info("Performance Measurement - Class: {}, Method: {}, Execution Time: {}ms",
                    className, methodName, totalTimeMillis);
        }
    }
}
```

비동기로 바꾼 메서드에 얼마나 시간 단축이 되었는 지 파악해야 합니다.

![img6](../transactional-1-img/img6.png)

위와 같이 정상적으로 로그가 출력된 것을 확인할 수 있었습니다.


지금까지 @Transactional을 알아보기 위해 차근차근 코드의 진화과정을 살펴보았습니다.  
흐름을 따라가다보면 이해가 되긴하지만 소화하는데 시간이 좀 걸렸습니다.

그래도 이렇게 직접 코드를 분석해보면서 이해하니까 훨씬 더 명확하게 이해가 된 것 같습니다.
