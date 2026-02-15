---
title: "가상 스레드 소스코드 파헤쳐보기"
date: 2026-02-14
categories: ["engineering"]
topics: ["탐구"]
description: "가상 스레드의 소스코드를 직접 분석해보며 이해해보는 글입니다."
draft: false
---

JDK 21 부터 가상 스레드가 도입되어 기존 워커 스레드를 통해 IO Bound 하는 것보다 가상 스레드가 좋다는 글은 봤었지만 
무엇때문에 그리고 왜 인지는 잘 몰랐습니다. 안그래도 스터디에서 "그러면 항상 가상스레드를 사용하면 좋나요?" 라는 질문이 들어왔었고 이번 기회에 가상 스레드에 대해 제대로 정리해보려고 합니다. 

[스터디 Issue 링크](https://github.com/system-design-case-study/issue-collection/issues/3) <- 이전에 정리한 글입니다.


## 가상스레드와 플랫폼 스레드 차이
![img1.png](../virtual-thread-1-img/img1.png)  
플랫폼 스레드는 OS 스레드 1개를 통째로 만든다는 모델이기에 만들어야 하는 데이터가 많습니다.
(JVM 쪽 pre-thread 구조체들, OS 쪽 스레드 제어 블록/스케줄링 관련 데이터 등등..)

가상 스레드는 OS 스레드를 새로 만들지 않고 필요할 때 mount/unmount를 통해 캐리어 스레드를 빌려서 사용합니다. 
따라서 상대적으로 저장공간이 많이 필요하지 않습니다. 


## 가상 스레드 클래스 구조
```java
final class VirtualThread extends BaseVirtualThread {
    private static final Unsafe U = Unsafe.getUnsafe();
    private static final ContinuationScope VTHREAD_SCOPE = new ContinuationScope("VirtualThreads");
    private static final ForkJoinPool DEFAULT_SCHEDULER = createDefaultScheduler();
    private static final ScheduledExecutorService UNPARKER = createDelayedTaskScheduler();
    private static final int TRACE_PINNING_MODE = tracePinningMode();

    private static final long STATE = U.objectFieldOffset(VirtualThread.class, "state");
    private static final long PARK_PERMIT = U.objectFieldOffset(VirtualThread.class, "parkPermit");
    private static final long CARRIER_THREAD = U.objectFieldOffset(VirtualThread.class, "carrierThread");
    private static final long TERMINATION = U.objectFieldOffset(VirtualThread.class, "termination");

    // scheduler and continuation
    private final Executor scheduler;
    private final Continuation cont;
    private final Runnable runContinuation;

    // virtual thread state, accessed by VM
    private volatile int state;

    /*
     * Virtual thread state and transitions:
     *
     *      NEW -> STARTED         // Thread.start
     *  STARTED -> TERMINATED      // failed to start
     *  STARTED -> RUNNING         // first run
     *
     *  RUNNING -> PARKING         // Thread attempts to park
     *  PARKING -> PARKED          // cont.yield successful, thread is parked
     *  PARKING -> PINNED          // cont.yield failed, thread is pinned
     *
     *   PARKED -> RUNNABLE        // unpark or interrupted
     *   PINNED -> RUNNABLE        // unpark or interrupted
     *
     * RUNNABLE -> RUNNING         // continue execution
     *
     *  RUNNING -> YIELDING        // Thread.yield
     * YIELDING -> RUNNABLE        // yield successful
     * YIELDING -> RUNNING         // yield failed
     *
     *  RUNNING -> TERMINATED      // done
     */
    private static final int NEW      = 0;
    private static final int STARTED  = 1;
    private static final int RUNNABLE = 2;     // runnable-unmounted
    private static final int RUNNING  = 3;     // runnable-mounted
    private static final int PARKING  = 4;
    private static final int PARKED   = 5;     // unmounted
    private static final int PINNED   = 6;     // mounted
    private static final int YIELDING = 7;     // Thread.yield
    private static final int TERMINATED = 99;  // final state

    // can be suspended from scheduling when unmounted
    private static final int SUSPENDED = 1 << 8;
    private static final int RUNNABLE_SUSPENDED = (RUNNABLE | SUSPENDED);
    private static final int PARKED_SUSPENDED   = (PARKED | SUSPENDED);

    // parking permit
    private volatile boolean parkPermit;

    // carrier thread when mounted, accessed by VM
    private volatile Thread carrierThread;

    // termination object when joining, created lazily if needed
    private volatile CountDownLatch termination;
    
    ...
}
```

**1. 전역 필드들**
- `UnSafe U` : `state`,`perkPermit`, `carriedThread` 같은 필드를 CAS 하거나 오프셋 기반으로 빠르게 접근하려고 사용합니다.
- `ContinuationScope VTHREAD_SCOPE` : Continuation이 어디까지를 가상 스레드 실행 단위로 볼지 구분하는 컨텍스트 입니다. 
- `ForkJoinPool DEFAULT_SCHEDULER` : 가상 스레드가 기본으로 올라타는 스케줄러 입니다.
- `ScheduledExecutorService UNPARKER` : sleep, parkNanos, 타임아웃 있는 대기 같은 지연 후 깨우기 작업을 처리하는 전용 스케줄러 입니다. 
- `TRACE_PINNING_MODE` : 가상 스레드가 PINNED 되는 상황을 추적/로그할지 결정하는 모드입니다. 

**2. objectFieldOffset들** 
- Unsafe로 CAS/volatile 접근을 할 때 리플렉션 비용을 줄이려고 오프셋을 미리 계산해 저장합니다. 
- 상태 전이를 자주 하니 빠르게 하려는 용도입니다. 

**3. 핵심 인스턴스들**
- `scheduler` : 이 가상 스레드를 어디에 실행시킬지 결정합니다. 
- `cont(Countinuation)` : 지금까지 어디까지 실행됐는지를 들고 있는 객체입니다. 
- `runContinuation` : cont를 실제로 실행시키기 위한 Runnable 래퍼입니다.

****4. 상태 관련 필드들**** 
- `state` : 가상 스레드의 상태를 저장하는 필드입니다. 
  - `RUNNABLE` = 실행 가능하지만 언마운트 상태 
  - `RUNNING` = 실행 가능 + 마운트 상태 
  - `PARKED` = 대기 중 + 언마운트
  - `PINNED` = 대기 중인데도 마운트

그 아래는 주석으로 이해 가능할 것 같아서 생략하겠습니다.


```java
/**
     * Runs a task in the context of this virtual thread. The virtual thread is
     * mounted on the current (carrier) thread before the task runs. It unmounts
     * from its carrier thread when the task completes.
     */
    @ChangesCurrentThread
    private void run(Runnable task) {
        assert state == RUNNING;

        // first mount
        mount();
        notifyJvmtiStart();

        // emit JFR event if enabled
        ...

        Object bindings = scopedValueBindings();
        try {
            runWith(bindings, task);
        } catch (Throwable exc) {
            dispatchUncaughtException(exc);
        } finally {
            try {
                // pop any remaining scopes from the stack, this may block
                StackableScope.popAll();

                ...

            } finally {
                // last unmount
                notifyJvmtiEnd();
                unmount();

                // final state
                setState(TERMINATED);
            }
        }
    }
```
run()메서드를 통해 가상 스레드를 캐리어 스레드와 연결/해제하는 mount/unmount 작업이 포함되어 있습니다. 
그리고 마지막은 상태를 `TERMINATED`로 변경하고 종료합니다. 

```java
    @ChangesCurrentThread
    @ReservedStackAccess
    private void mount() {
        // sets the carrier thread
        Thread carrier = Thread.currentCarrierThread();
        setCarrierThread(carrier);

        // sync up carrier thread interrupt status if needed
        ...
        }

        // set Thread.currentThread() to return this virtual thread
        carrier.setCurrentThread(this);
    }
```
mount() 메서드 내부를 보면 `setCarrierThread` <-> `setCurrentThread` 로 양방향 매핑을 진행합니다. 

이후에 스케줄러가 runContinuation()을 실행합니다. 
```java
private void runContinuation() {
        // the carrier must be a platform thread
        if (Thread.currentThread().isVirtual()) {
            throw new WrongThreadException();
        }

        // set state to RUNNING
        int initialState = state();
        if (initialState == STARTED && compareAndSetState(STARTED, RUNNING)) {
            // first run
        } else if (initialState == RUNNABLE && compareAndSetState(RUNNABLE, RUNNING)) {
            // consume parking permit
            setParkPermit(false);
        } else {
            // not runnable
            return;
        }

        // notify JVMTI before mount
        notifyJvmtiMount(/*hide*/true); 

        try {
            cont.run();
        } finally {
            if (cont.isDone()) {
                afterTerminate();
            } else {
                afterYield();
            }
        }
    }
```
코드를 보면 재밌는점이 
```java
if (Thread.currentThread().isVirtual()) throw new WrongThreadException();
```
가상 스레드가 가상스레드를 사용할 수 없다는 것을 명시하고 있습니다. 
따라서 재귀호출은 걱정할 필요가 없을 것 같습니다. 

그 다음에 상태를 RUNNABLE로 바꾸고 try 문 안에서 cont.run()으로 실행하는 것을 알 수 있습니다. 

여기까지 살펴봤을 때 아직 가상 스레드의 내부 값을 저장하는 Continuation 구조를 살펴보지 않았습니다.

```java
public class Continuation {
  
  ...

  static {
      ContinuationSupport.ensureSupported();

      StackChunk.init(); // ensure StackChunk class is initialized

      String value = System.getProperty("jdk.preserveScopedValueCache");
      PRESERVE_SCOPED_VALUE_CACHE = (value == null) || Boolean.parseBoolean(value);
  }

  ...
}
```

Continuation 클래스를 보면 핵심은 Pinned와 관련된 처리(생략)와 StackChunk를 확인할 수 있습니다.

StackChunk를 들어가 보겠습니다.
```java
public final class StackChunk {
    public static void init() {}

    private StackChunk parent;
    private int size;    // in words
    private int sp;      // in words
    private int bottom;  // in words

    // The stack itself is appended here by the VM, as well as some injected fields

    public StackChunk parent() { return parent; }
    public boolean isEmpty()   { return sp == bottom; }
}
```

여기서 주석처리를 해석해보면 자바 소스에 보이는 parent/size/sp/bottom은 메타데이터 헤더고  
실제 스택 프레임 데이터는 VM이 StackChunk 객체의 메모리 레이아웃 뒤쪽에 붙여서 저장한다고 합니다. 

JDK 자바 소스만으로는 VM이 payload에 스택을 저장/복원하는 상세 구현까지 따라가긴 어렵지만, **가상 스레드의 실행 스택 상태가 StackChunk(체인)로 힙에 저장될 수 있다는 점은 확인할 수 있습니다.**

또한 가상 스레드가 블로킹될 때는 park() 내부에서 Continuation.yield()가 호출되며, 이 과정에서 스레드는 캐리어에서 언마운트되고 실행 상태가 StackChunk로 보관됩니다. 이후 unpark()가 호출되면 다시 RUNNABLE로 전이되어 스케줄러가 runContinuation을 실행하면서 캐리어 위에서 실행을 이어갑니다.

여기까지 가상 스레드의 내부 구조를 살펴보았습니다. 

다음으로는 Synchronized일 때 Pinning이 걸리는 상황과 ReentrantLock으로는 왜 해결이 되는지 살펴보겠습니다.

읽어주셔서 감사합니다.
