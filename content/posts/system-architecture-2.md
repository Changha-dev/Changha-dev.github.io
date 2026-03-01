---
title: "시스템 설계2 - 2장 (feat. Redis adapter, pub/sub 내부 파헤쳐보기)"
date: 2026-02-26
categories: ["engineering"]
topics: ["탐구"]
description: "가상면접 시스템 설계2 - 2장을 읽고나서 더 탐구하고 싶은 내용을 작성하였습니다."
utterancesRepo: "system-design-case-study/issue-collection"
utterancesIssueTerm: "system-architecture-2-comments"
draft: false
---

## 2장을 읽고나서
2장은 주변 사람들과 실시간 위치공유 시스템을 설계하는 것이었습니다.
읽으면서 Websocket과 Redis pub/sub에 대해 좀 더 궁금한 부분들이 있었고 그것들에 대해서 얘기해보려고 합니다. 

![img1](../system-architecture-2-img/img1.png)

위 사진처럼 Socket은 다중 인스턴스일 때 사용자마다 다른 인스턴스에 연결되어 있으니  
이부분을 고려해야 되었습니다. 책에서는 이부분에 대한 설명은 없다보니 직접 찾아보았습니다.

두가지의 솔루션이 있었습니다. 인스턴스끼리 정보 공유를 위한 직접 Socket 연결을 하는 방식,
그리고 Redis Adapter를 사용하여 브로드캐스트 하는 방식입니다.
### 직접 Socket 연결
![img3](../system-architecture-2-img/img3.png) 
이 방식은 서로 인스턴스끼리 Websocket 연결을 한 후 직접 메시지를 전달합니다.  
특정 인스턴스로만 가도록 설정을 할 수 있기에 장점이 있지만 인스턴스 수가 많아지면 Mash 방식으로 연결을 해야 하기에 관리 복잡성이 증가합니다. 

### Redis Adapter 활용 
이 방식은 Socke.io 공식 홈페이지에서 설명하고 있습니다.
![img2](../system-architecture-2-img/img2.png)
![img4](../system-architecture-2-img/img4.png) 
Redis pub/sub 메커니즘을 활용하여 다른 서버에 전파하는 방식입니다.  
이 방식에서 알아야 할 것은 각 서버에 Socket 연결 정보는 그대로 있다는 것입니다.  
따라서 pub/sub 방식을 통한 브로드캐스트로 모든 서버가 일단 메시지를 받고 각 서버 안에서 매칭되는 room이 있는지 확인하는 작업을 거칩니다.
![img5](../system-architecture-2-img/img5.png)
공식문서에서 설명하듯 Redis adapter는 Redis에 room/소켓 상태를 key로 저장하지 않습니다.  
그러면 Redis adapter에서는 무엇을 가지고 정보전달을 하는지 알아보고자 합니다.
Redis adapter의 소스코드로 좀 더 자세히 확인해보겠습니다.  
### Redis adapter
```java
 /**
   * Adapter constructor.
   *
   * @param nsp - the namespace
   * @param pubClient - a Redis client that will be used to publish messages
   * @param subClient - a Redis client that will be used to receive messages (put in subscribed state)
   * @param opts - additional options
   *
   * @public
   */
  constructor(
    nsp: any,
    readonly pubClient: any,
    readonly subClient: any,
    opts: Partial<RedisAdapterOptions> = {}
  ) {
    super(nsp);

    this.uid = uid2(6);
    this.requestsTimeout = opts.requestsTimeout || 5000;
    this.publishOnSpecificResponseChannel = !!opts.publishOnSpecificResponseChannel;

    const prefix = opts.key || "socket.io";

    this.channel = prefix + "#" + nsp.name + "#";
    this.requestChannel = prefix + "-request#" + this.nsp.name + "#";
    this.responseChannel = prefix + "-response#" + this.nsp.name + "#";
    const specificResponseChannel = this.responseChannel + this.uid + "#";

    const isRedisV4 = typeof this.pubClient.pSubscribe === "function";
    if (isRedisV4) {
      this.subClient.pSubscribe(
        this.channel + "*",
        (msg, channel) => {
          this.onmessage(null, channel, msg);
        },
        true
      );
      this.subClient.subscribe(
        [this.requestChannel, this.responseChannel, specificResponseChannel],
        (msg, channel) => {
          this.onrequest(channel, msg);
        }
      );
    }
    ...
  }
```
Redis adapter의 생성자입니다. 
```java
this.uid = uid2(6);
```
식별 번호를 위해 uid로 랜덤한 값을 만듭니다. 
```java
this.subClient.pSubscribe(
        this.channel + "*",
        (msg, channel) => {
          this.onmessage(null, channel, msg);
        },
        true
      );
this.subClient.subscribe(
[this.requestChannel, this.responseChannel, specificResponseChannel],
(msg, channel) => {
  this.onrequest(channel, msg);
}
);
```
위 코드를 통해 채널과 `pSubscribe`, `subscribe`를 동시에 하는 것을 알 수 있습니다.  
pSubscribe는 패턴을 통한 구독이고 subscribe는 정해진 특정 채널을 구독합니다.
![img6](../system-architecture-2-img/img6.png)
위와 같은 형태로 그릴 수 있겠습니다. 여기서 Client는 어떤 내용으로 이루어졌는지 궁금하여 이어서 살펴보겠습니다.
### Client 소스코드
```java
typedef struct client {
    /* 1) "구독자 = 연결"을 보여주는 핵심 */
    uint64_t id;            /* Redis 내부 고유 client id */
    uint64_t flags;         /* CLIENT_* 플래그 (PUBSUB 모드 등) */
    connection *conn;       /* 실제 TCP/TLS/Unix 연결 핸들 */

    /* 2) 프로토콜/인증 같은 연결 상태 */
    int resp;               /* RESP2 or RESP3 */
    int authenticated;      /* 인증 여부(ACL/requirepass 등) */
    time_t lastinteraction; /* 마지막 상호작용 시간(타임아웃/idle 등) */

    /* 3) Pub/Sub: "이 client가 뭘 구독 중인지" */
    dict *pubsub_channels;       /* SUBSCRIBE한 채널 집합(=set) */
    dict *pubsub_patterns;       /* PSUBSCRIBE한 패턴 집합(=set) */
    dict *pubsubshard_channels;  /* SSUBSCRIBE(sharded pubsub) 집합(=set) */

    /* 4) 출력 버퍼 */
    list *reply;                 /* 응답(출력) 큐 */
    unsigned long long reply_bytes; /* reply 큐에 쌓인 바이트 */
    size_t sentlen;              /* 현재 reply에서 이미 보낸 길이 */

    /* 작은 응답은 고정 버퍼로도 나감*/
    char *buf;
    size_t bufpos;
    size_t buf_usable_size;

} client;
```
코드에서 먼저 connection쪽을 살펴보겠습니다.
Client는 인스턴스당 1개라는 고정관념이 있었습니다. 정확히 어떻게 연결과정에서 어떤 것들이 저장되어있는지 궁금하여 
Connection 소스코드도 확인해보겠습니다.
```java
struct connection {
    ConnectionType *type;
    ConnectionState state;
    int fd;
    ...
};
```
이곳에 fd(file descriptor)가 있었고 연결당 하나씩 생기는 구조입니다.  
fd에 대한 개념이 헷갈려서 그림으로 도식화해보았습니다.
![img7](../system-architecture-2-img/img7.png)
위와 같이 열려있는 포트로 서버에서 연결을 요청합니다. 이후 Redis에서 accept()를 하면 새로운 fd를 할당해줍니다. 
그 fd로 서버쪽 새로운 fd와 TCP 연결을 통해 이루어집니다.
```java
static void connSocketAcceptHandler(aeEventLoop *el, int fd, void *privdata, int mask) {
    int cport, cfd;
    int max = server.max_new_conns_per_cycle;
    char cip[NET_IP_STR_LEN];
    UNUSED(mask);
    UNUSED(privdata);

    while(max--) {
        cfd = anetTcpAccept(server.neterr, fd, cip, sizeof(cip), &cport);
        ...
        acceptCommonHandler(connCreateAcceptedSocket(el,cfd,NULL), 0, cip);
    }
}
```
위 코드에서 매개변수 `fd`는 6379에 바인딩된 fd이고 while문 안에 있는 `cfd`가 새로운 TCP 연결에 해당하는 
Redis측 새로운 fd 입니다.  
여기서 재밌는 부분이 max에 대한 것인데요. 이 변수의 역할은 한번의 while문에서 최대 몇개의 conn까지 연결할지 설정하는 것입니다.   
max가 클수록 새 연결은 빨리 받지만, 다른 작업이 밀릴 수 있습니다. 반대로 작아질수록 새 연결 수락이 느려질 수 있겠습니다.  
이부분이 하나의 튜닝포인트가 될 수 있다고 느꼈습니다.  
또한 레디스의 싱글 스레드의 특성으로 인해 유의해야 할 부분이 아닌가 생각이 들었습니다.  

이어서 Client 소스코드를 보겠습니다.
```java
/* 3) Pub/Sub: "이 client가 뭘 구독 중인지" */
    dict *pubsub_channels;       /* SUBSCRIBE한 채널 집합(=set) */
    dict *pubsub_patterns;       /* PSUBSCRIBE한 패턴 집합(=set) */
    dict *pubsubshard_channels;  /* SSUBSCRIBE(sharded pubsub) 집합(=set) */
```
채널과 패턴에 대한 저장소를 클라이언트쪽에서도 관리하고 있다는 것을 알 수 있습니다.

```java
/* 4) 출력 버퍼 */
    list *reply;                 /* 응답(출력) 큐 */
    unsigned long long reply_bytes; /* reply 큐에 쌓인 바이트 */
    size_t sentlen;              /* 현재 reply에서 이미 보낸 길이 */

    /* 작은 응답은 고정 버퍼로도 나감*/
    char *buf;
    size_t bufpos;
    size_t buf_usable_size;
```
버퍼와 관련된 부분을 살펴보겠습니다.  
Redis는 클라이언트에 내용을 전송하기 전에 buffer에 담고 전송하고 있습니다.
![img8](../system-architecture-2-img/img8.png)
위 도식화처럼 작은 응답은 `char *buf`를 이용하고 큰 내용이거나 쌓이게 된다면 `list *reply`를 활용합니다.

여기서 문제가 될 수 있는 부분이 버퍼에 계속 쌓이게 되는 상황입니다.
즉, 소켓이 writable 될 때 마다 밀어내야하는데 그렇지 못할 때 입니다.
#### config.c
```java
clientBufferLimitsConfig clientBufferLimitsDefaults[CLIENT_TYPE_OBUF_COUNT] = {
    {0, 0, 0}, /* normal */
    {1024*1024*256, 1024*1024*64, 60}, /* slave : hard 256MB / soft 64MB for 60s */
    {1024*1024*32, 1024*1024*8, 60}  /* pubsub : hard 32MB / soft 8MB for 60s */
};
```
기본값으로 위와 같이 설정되어 있습니다. slave는 Redis 사이의 연결용이라 데이터 복제를 위한 어느정도 크기가 필요하여 더 크게 잡혀있습니다.  
반면 pubsub은 실시간성을 위해 쌓이는 것을 되도록 빨리 판단해야하므로 더 작게 잡혀있는 것이라고 판단됩니다.

위 크기를 조절하는 것도 튜닝 포인트가 될 수 있겠습니다.

### 느낀점
소켓간 통신에서 어떻게 인스턴스 연결을 할까에서 Redis adapter, pub/sub 내부 자료구조나 동작방식에 대해 살펴보았습니다.  
아직 구현을 직접 해보진 않아서 직접 사용해보면서 생기는 고민점들을 나중에 더 추가해보려고 합니다. 
그리고 채널톡의 관련 기술 블로그 자료들이 상당히 유용하였습니다.
- [채널톡 실시간 채팅 서버 개선 여정(1)](https://channel.io/ko/team/blog/articles/%EC%B1%84%EB%84%90%ED%86%A1-%EC%8B%A4%EC%8B%9C%EA%B0%84-%EC%B1%84%ED%8C%85-%EC%84%9C%EB%B2%84-%EA%B0%9C%EC%84%A0-%EC%97%AC%EC%A0%951-4571f5b3)
- [채널톡 실시간 채팅 서버 개선 여정(3)](https://channel.io/ko/team/blog/articles/%EC%B1%84%EB%84%90%ED%86%A1-%EC%8B%A4%EC%8B%9C%EA%B0%84-%EC%B1%84%ED%8C%85-%EC%84%9C%EB%B2%84-%EA%B0%9C%EC%84%A0-%EC%97%AC%EC%A0%953-ebbb3712)
- [Socket.io Redis Adapter 구현을 통한 트래픽 개선](https://channel.io/ko/team/blog/articles/272a0c19?utm_source=chatgpt.com)

한번씩 참고하셔도 좋을 것 같습니다.

---
참고 자료 
- [Redis adapter 공식문서](https://socket.io/docs/v4/redis-adapter/)
- [Socket.io Redis adapter 소스코드](https://github.com/socketio/socket.io-redis-adapter/blob/d55d6e5fc986b9ee7a6b866a9694d8f0b005eb8d/lib/index.ts)
- [Redis pub/sub 소스코드](https://github.com/redis/redis/blob/unstable/src/pubsub.c#L25)
- [Redis connection 소스코드](https://github.com/redis/redis/blob/unstable/src/connection.h)
- [Redis socket 소스코드](https://github.com/redis/redis/blob/unstable/src/socket.c)
