---
title: "Synchronizer의 Lock 원리 파헤치기"
date: 2026-02-19
categories: ["engineering"]
topics: ["탐구"]
description: "Synchronizer의 Lock 원리를 자세히 살펴보고, 내부 동작 방식을 이해하는 글입니다."
draft: false
---

Synchronized 메서드는 락 메커니즘 중 하나로 알고있고 메서드 단위에서 사용 가능하다고 알고 있습니다. 
그리고 VirtualThread의 Pinning 상황 발생 원인 중 하나가 Synchronized 메서드를 사용할 때 였습니다. 
그래서 Synchronized일때 왜 그러는지 좀 더 자세히 살펴보고자 내부 원리를 살펴보려고 합니다.

Synchronized 코드를 보면서 새로 알게 된 것이 두 가지의 case로 나누어 락을 진행한다는 것입니다. 
1. Fast-lock
2. Heavyweight-lock

FastLock은 말 그대로 빠르고 가볍게 실행할 수 있는 락입니다. 
가볍다는 것은 lock을 위해 ObjectMonitor를 만들 필요 없이 객체 헤더(mark word)를 CAS 방식을 통해 lock_stack에   
자신이 잡았다는 것을 기록하며 진행하는 방식입니다. 

반면 Heavyweight-lock은 가벼운 방식만으로는 락을 유지하거나 대기/깨움 같은 기능을 제공하기 어려운 상황에서 선택되는 경로입니다.
참고로 `inflate`라는 표현을 공식문서에서 자주 볼 수 있는데 Fast 방식에서 Heavyweight 방식으로 승격되었다는 뜻입니다.


## ObjectSynchronzer::enter
```java
void ObjectSynchronizer::enter(Handle obj, BasicLock* lock, JavaThread* current) {
	
  // two yields 이후 sleeping
  // deflation 상황일 경우 발동 (while문 안에 로직 존재)
  SpinYield spin_yield(0, 2);
  
  bool observed_deflation = false;

  LockStack& lock_stack = current->lock_stack();

  // 재진입시 빠르게 처리
  if (!lock_stack.is_full() && lock_stack.try_recursive_enter(obj())) {
    return;
  }
    
  // 현재 스레드가 이미 fast-lock 상황일 때, 승격이 필요해져서 ObjectMonitor로 전환
  if (lock_stack.contains(obj())) {
    // 경량락 -> 중량락으로 전환하는 과정
    ObjectMonitor* monitor = inflate_fast_locked_object(obj(), ObjectSynchronizer::inflate_cause_monitor_enter, current, current);
    bool entered = monitor->enter(current);
    return;
  }

  while (true) {
    if (fast_lock_try_enter(obj(), lock_stack, current)) {
      return;
    } else if (UseObjectMonitorTable && fast_lock_spin_enter(obj(), lock_stack, current, observed_deflation)) {
      // 임계구역이 짧으면 곧 락이 풀릴 가능성이 높아서 좀 더 fast-lock 시도
      return;
    }

	// deflation을 봤다면 양보
    if (observed_deflation) {
      spin_yield.wait();
    }
	
	// 더이상 피할 수 없을 때 ObjectMonitor
    ObjectMonitor* monitor = inflate_and_enter(obj(), lock, ObjectSynchronizer::inflate_cause_monitor_enter, current, current);

    if (monitor != nullptr) {
      cache_setter.set_monitor(monitor);
      return;
    }
	  
    observed_deflation = true;
  }
}
```

코드를 보면 재진입에 대한 처리가 두가지가 있습니다. 
```java
if (!lock_stack.is_full() && lock_stack.try_recursive_enter(obj())) {
    return;
  }
    
  // 현재 스레드가 이미 fast-lock 상황일 때, 승격이 필요해져서 ObjectMonitor로 전환
  if (lock_stack.contains(obj())) {
    ...
	}
```
첫번째 if문은 lock_stack, 즉 fast-lock으로 가능한 경우이고 
두번째 if문은 이제 fast-lock으로는 어려운 상황일때 ObjectMonitor 방식으로 승격한다는 것입니다. 

아래 while 블록은 락 획득 메인 루프로서, 여기에서도 가능하다면 fast-lock으로 끝내고, 정말 안 될 때만 inflate로 넘어간다는 방식입니다.
(단 deflation 레이스는 곧 모니터를 회수한다는 의미이므로 끝날때까지 spin 방식을 통해 양보하며 재시도합니다.)

```java
if (fast_lock_try_enter(obj(), lock_stack, current)) return;
```
객체 헤더가 unlocked이면 CAS로 fast_locked로 바꾸는 로직입니다. 

내부 메서드를 확인해보면 
```java
inline bool ObjectSynchronizer::fast_lock_try_enter(oop obj, LockStack& lock_stack, JavaThread* current) {
  markWord mark = obj->mark();
  while (mark.is_unlocked()) {
    ... 
    markWord locked_mark = mark.set_fast_locked();
    markWord old_mark = mark;
    mark = obj->cas_set_mark(locked_mark, old_mark);
    if (old_mark == mark) {
      // Successfully fast-locked, push object to lock-stack and return.
      lock_stack.push(obj);
      return true;
    }
  }
  return false;
}
```
unlocked인지 확인하고 CAS 방식으로 lock_stack에 push하는 로직을 확인할 수 있습니다. 

다음으로 
```java
else if (UseObjectMonitorTable && fast_lock_spin_enter(..., observed_deflation)) return;
```
fast_lock_try_enter는 실패해도 임계구역이 짧으면 락이 곧 풀릴 수 있기에 잠깐 spin 해보는 코드입니다. 
```java
bool ObjectSynchronizer::fast_lock_spin_enter(oop obj, LockStack& lock_stack, JavaThread* current, bool observed_deflation) {
  const int log_spin_limit = os::is_MP() ? FastLockingSpins : 1;
  const int log_min_safepoint_check_interval = 10;

  markWord mark = obj->mark();
  const auto should_spin = [&]() {
    if (!mark.has_monitor()) {
      // Spin while not inflated.
      return true;
    } else if (observed_deflation) {
      // Spin while monitor is being deflated.
      ObjectMonitor* monitor = ObjectSynchronizer::read_monitor(current, obj, mark);
      return monitor == nullptr || monitor->is_being_async_deflated();
    }
    // Else stop spinning.
    return false;
  };
  
  // Always attempt to lock once even when safepoint synchronizing.
  bool should_process = false;
  for (int i = 0; should_spin() && !should_process && i < log_spin_limit; i++) {
    // Spin with exponential backoff.
    const int total_spin_count = 1 << i;
    const int inner_spin_count = MIN2(1 << log_min_safepoint_check_interval, total_spin_count);
    const int outer_spin_count = total_spin_count / inner_spin_count;
    for (int outer = 0; outer < outer_spin_count; outer++) {
      should_process = SafepointMechanism::should_process(current);
      if (should_process) {
        // Stop spinning for safepoint.
        break;
      }
      for (int inner = 1; inner < inner_spin_count; inner++) {
        SpinPause();
      }
    }

    if (fast_lock_try_enter(obj, lock_stack, current)) return true;
  }
  return false;
}
```
spin 방식일 때 생각보다 몇가지 고려하는 사항들이 있다는 것을 확인할 수 있었습니다. 
1. 멀티코어 여부 
2. 지수 백오프, 청크 방식을 통한 spin 최적화
3. Stop The World 고려

```java
const int log_spin_limit = os::is_MP() ? FastLockingSpins : 1;
```
여기서 멀티코어인지에 따라 스핀 할지를 결정합니다. 
만약 싱글코어라면 spin으로 인해 다른 스레드에서 처리를 하지 못하기에 오히려 상황이 악화될 수 있습니다. 
멀티코어라면 다른 CPU에서도 작업을 하는 병렬 작업이 가능하기에 이때는 스핀 방식이 유효합니다.
    
```java
  bool should_process = false;
  for (int i = 0; should_spin() && !should_process && i < log_spin_limit; i++) {
    const int total_spin_count = 1 << i;
    const int inner_spin_count = MIN2(1 << log_min_safepoint_check_interval, total_spin_count);
    const int outer_spin_count = total_spin_count / inner_spin_count;
    for (int outer = 0; outer < outer_spin_count; outer++) {
      should_process = SafepointMechanism::should_process(current);
      if (should_process) {
        break;
      }
      for (int inner = 1; inner < inner_spin_count; inner++) {
        SpinPause();
      }
    }

    if (fast_lock_try_enter(obj, lock_stack, current)) return true;
  }
```

총 3중 루프로 구성되어있습니다. 

#### 바깥 루프
```java
for (int i = 0; should_spin() && !should_process && i < log_spin_limit; i++) {
  const int total_spin_count = 1 << i;
  ...
  if (fast_lock_try_enter(...)) return true;
}
```
여기서는 지수 백오프 방식으로 스핀강도를 올리는 루프입니다. 
매 단계 끝에 `fast_lock_try_enter`를 한 번 해봐서 락이 풀렸는지 확인합니다.

#### 중간 루프
```java
const int inner_spin_count = MIN2(1 << 10, total_spin_count);
const int outer_spin_count = total_spin_count / inner_spin_count;

for (int outer = 0; outer < outer_spin_count; outer++) {
  should_process = SafepointMechanism::should_process(current);
  if (should_process) break;
  ...
}
```
safepoint 체크를 청크 단위로 수행하는 루프입니다. 
이는 STW(Stop The World)와 관련있는데 JVM 에서 각 스레드의 정보를 동기화 하기 위해 필요한 로직입니다.
spin으로 인해 이를 늦추면 문제가 생길 수 있고 그렇다고 매번 `should_process()`를 호출하면 비용이 커지기에  
청크 단위로 진행합니다.

#### 안쪽 루프
```java
for (int inner = 1; inner < inner_spin_count; inner++) {
  SpinPause();
}
```
실제 기다림을 수행하는 루프입니다.
CPU pause를 반복하며 시간을 벌어주는 역할을 합니다. 

다시한번 정리하면  
**바깥 루프** : 기다림을 1->2->4->8 .. 로 늘려가는 지수백오프 방식  
**중간 루프** : 기다림을 청크로 나눠 청크마다 safepoint 체크  
**안쪽 루프** : 청크 안에서 `Spinpause()`로 실제 스핀

여기까지 해서 `ObjectSynchronizer::enter`의 fast-lock에 대해 알아보았습니다.  
다음으로는 이제 ObjectMonitor 방식에 대해 알아보겠습니다. 

## ObjectMonitor::enter
```java
bool ObjectMonitor::enter(JavaThread* current, bool post_jvmti_events) {
	
  // spin인지 deflation상태인지 다시 한번 확인하는 코드	
  ...
  // 이제 진짜로 경합 진입
  enter_with_contention_mark(current, contention_mark, post_jvmti_events);
  return true;
}
```
enter안에는 다시한번 spin으로 확인해보는 코드와 deflation상태인지 체크하는 코드가 있습니다.  
그 후 이제 `enter_with_contention_mark` 메서드로 정말 경합 진입으로 갑니다. 


## ObjectMonitor::enter_with_contention_mark
```java
void ObjectMonitor::enter_with_contention_mark(JavaThread* current,
                                               ObjectMonitorContentionMark& cm,
                                               bool post_jvmti_events) {
  ...
    
  // 핵심 1) VirtualThread면 먼저 preempt(unmount) 시도
  freeze_result result = freeze_fail; // (enum 값은 예시)
  ContinuationEntry* ce = current->last_continuation();
  bool is_virtual = (ce != nullptr && ce->is_virtual_thread());

  if (is_virtual) {
    notify_contended_enter(current, post_jvmti_events);

    result = Continuation::try_preempt(current, ce->cont_oop(current));
    if (result == freeze_ok) {
      // freeze 성공: vthread를 monitor 대기 구조에 등록하고 Java로 돌아가 unmount 진행
      bool acquired = vthread_monitor_enter(current);
      if (acquired) {
        // 등록 과정에서 운 좋게 락을 잡으면 preempt 취소
        current->set_preemption_cancelled(true);
        if (post_jvmti_events && JvmtiExport::should_post_monitor_contended_entered()) {
          current->set_contended_entered_monitor(this);
        }
      }
      current->set_current_pending_monitor(nullptr);
      return;
    }
    // freeze 실패면 아래 "일반 경합 경로"로 떨어짐 (이때 pinning 가능)
  }

  // 핵심 2) 플랫폼 스레드 방식의 경합 처리: entry_list + park
  {
    JavaThreadBlockedOnMonitorEnterState jtbmes(current, this);

    if (!is_virtual) {
      notify_contended_enter(current, post_jvmti_events);
    }
    OSThreadContendState osts(current->osthread()); // OS 스레드도 contend 중이라는 걸 반영

    for (;;) {
      ...
      {
        ...
        enter_internal(current);  // enqueue(_entry_list) + park/unpark + owner 획득
        current->set_current_pending_monitor(nullptr);
      }
	  ...
    }
  }
  
  ...
}
```
JDK24버전의 설명대로 가상 스레드 인지 여부를 먼저 체크합니다.  
만약 가상 스레드라면 플랫폼 스레드에 대해 freeze, unmount를 하고 직접 락을 가상스레드와 연결하는 과정을 거칩니다.  
가상 스레드인지 체크는 `last_continuation() != null && ce->is_virtual_thread()`로 합니다.   
Continuation은 가상 스레드의 메타 데이터나 pinning여부를 관리하는 역할을 한다는 것을 이전 글에서 확인하였습니다. [이전 글](https://changha-dev.github.io/posts/virtual-thread-1/)

이후에 핵심 2를 보면 for문이 있는데 여기는 safepoint/suspend와 같은 VM요청과 락 획득을 안전하게 섞기 위한 프로토콜입니다.  
락 관련 핵심만 보기위해 ... 으로 치환하였고 핵심 메서드는 `enter_internal()`입니다. 

## ObjectMonitor::enter_internal
```java
void ObjectMonitor::enter_internal(JavaThread* current) {
  ...
    
  // 1) 즉시 획득 시도 (TATAS: test-and-test-and-set)
  if (try_lock(current) == TryLockResult::Success) return;

  // 2) park 하기 전 한 번 더 짧게 스핀(최적화)
  if (try_spin(current)) return;

  // 3) 경쟁자 큐(entry_list)에 자신을 등록
  ObjectWaiter node(current);
  current->_ParkEvent->reset();

  // 3-1) 큐에 넣는 동안 락이 풀릴 수 있으니 "락 획득 or enqueue" 레이스를 닫음
  if (try_lock_or_add_to_entry_list(current, &node)) return; // 운 좋게 획득

  // 4) 이제 진짜 대기(park) 루프: 깨어나서 재경쟁
  bool timed = has_unmounted_vthreads();   // 특수 케이스 완화용
  jlong interval = 1;

  for (;;) {
    if (try_lock(current) == TryLockResult::Success) break;

    // 잠들기 (필요 시 timed-park)
    if (timed) {
      current->_ParkEvent->park(interval);
      interval = MIN2(interval * 8, MAX_RECHECK_INTERVAL);
    } else {
      current->_ParkEvent->park();
    }

    // 깨어난 뒤 다시 경쟁
    if (try_lock(current) == TryLockResult::Success) break;

    // 또 짧게 스핀해서 park/unpark 왕복을 줄임
    if (try_spin(current)) break;
	
	...
  }

  // 5) 락 획득 완료: entry_list에서 내 노드를 제거하고 successor 정리
  unlink_after_acquire(current, &node);
  
  ...
}
```
enter_internal 코드는 
- try_lock / try_spin 으로 잡히는 지 확인
- 아니면 entry_list에 enqueue
- 그리고 park로 잠듦
- 깨어나면 try_lock / try_spin 반복
- 성공하면 entry_list에서 자기 노드를 unlink하고 종료
이렇게 정리할 수 있겠습니다. 

근데 결국 fast-lock과 heavyweight-lock을 모두 확인해보니 로직상 크게 차이점이 없어보였습니다.
왜냐면 둘 다 대기 전략(spin/재시도) 패턴이기에 비슷해보였습니다. 

하지만 스레드 로컬 lock_stack에 락 관리를 하는 fast-lock과 달리 heavyweight-lock은 ObjectMonitor 객체를 생성해야 합니다. 
```java
ObjectMonitor::ObjectMonitor(oop object) :
  _metadata(0),
  _object(_oop_storage, object),
  _owner(NO_OWNER),
  _previous_owner_tid(0),
  _next_om(nullptr),
  _recursions(0),
  _entry_list(nullptr),
  _entry_list_tail(nullptr),
  _succ(NO_OWNER),
  _SpinDuration(ObjectMonitor::Knob_SpinLimit),
  _contentions(0),
  _unmounted_vthreads(0),
  _wait_set(nullptr),
  _waiters(0),
  _wait_set_lock(0)
{ }
```

경합이 길어질 경우 `wait()`, `notify()`과 같은 기능을 사용할 수 있도록 락 상태와 대기 큐를 관리하는 자료구조가 필요하게 됩니다.  
`entry_list`은 락을 얻으려고 하는 대기 큐이고 `wait_set`은 락을 가진 상태에서 `wait()`로 조건 대기하는 큐입니다.  
그리고 `notify()`는 `wait_set`에서 꺼낸 스레드를 `entry_list`으로 옮겨서 다시 락을 얻을 기회를 주는 역할을 합니다.  
_(wait_set은 set인 이유가 있나 했더니 자료구조로서의 차이는 없고 둘 다 list로 구현되어 있습니다.)_

---

여기까지 Synchronizer의 소스코드를 직접 분석해보면서 Lock 동작 과정을 알아보았습니다.  
최대한 ObjectMonitor를 피하려는 코드 최적화가 있는 것이 흥미로웠습니다. (중간중간 혹시 모를 Spin연산 넣기, deflation인지 체크 ..)
그리고 JDK24버전과 JDK21버전을 비교하고 정말 Spinning관련 내용이 업데이트 되어있는 것을 두 눈으로 확인할 수 있었습니다. (점차 소스코드 보는 것에 대한 거부감이 사라지는 느낌..?)