---
title: Java 后端开发入门：从 Spring Boot 到微服务架构
category: backend
platform: backend-java
tags: ["Java", "Spring Boot", "后端", "微服务"]
readTime: 15分钟
featured: false
date: 2026-07-28
---

每年都有人喊"Java 要凉了"，结果打开招聘软件，后端岗位还是 Java 居多。这事儿挺有意思，技术选型这东西，很多时候不是看哪个语言更时髦，而是看哪个更省心。Java 凭啥稳坐后端头把交椅，Spring Boot 怎么快速上手，单体什么时候该拆成微服务，这篇就一步步讲明白。

## 为啥 Java 还是后端主流

新语言层出不穷，Go、Rust、Kotlin 都很能打，可企业后端这块 Java 依旧是大头。原因不复杂：

**生态成熟得离谱。** 想接个数据库，JDBC 是标配；想做个 ORM，有 Hibernate、MyBatis；想搞个消息队列，RocketMQ、Kafka 都有现成客户端；想加个缓存，Spring Cache 一行注解搞定。几乎碰得到的工程问题，前人都踩过坑、封装好库了。新语言再优雅，生态补齐得花好几年。

**性能稳定。** JVM 经过二十多年打磨，GC、JIT 都很能打。Java 启动慢、内存吃得多这毛病确实存在，但一旦跑起来，稳态吞吐量一点不差。后端服务大多是长跑进程，这点 Java 占便宜。

**企业级的命。** 强类型、工具链（IDEA 那重构能力谁用谁知道）、规范完整、招人容易、好维护。对一家公司来说，"能招到人接手"比"语言本身多先进"重要多了。老代码跑十年还能改得动，这事换别的语言未必做得到。

说白了，选 Java 不是因为它酷，是因为它省事、省人、省钱。

## Spring Boot 快速上手

以前写个 Java Web，得配一堆 XML，Tomcat 自己装，依赖自己管，新人上手光配环境就得一天。Spring Boot 把这些全自动化了——"约定优于配置"，开箱即用。

起个项目最快的办法是用 Spring Initializr（start.spring.io），勾几个依赖就生成一个能跑的骨架。一个最简单的 REST API 长这样：

```java
@RestController
@RequestMapping("/api/users")
public class UserController {

    @GetMapping("/{id}")
    public User getUser(@PathVariable Long id) {
        return userService.findById(id);
    }

    @PostMapping
    public User createUser(@RequestBody @Valid UserDTO dto) {
        return userService.create(dto);
    }
}
```

`@RestController` 是 `@Controller` + `@ResponseBody` 的合体，返回值直接序列化成 JSON。`@GetMapping`、`@PostMapping` 这些注解把 HTTP 方法和路径绑到方法上，一看就懂。

启动类更简单：

```java
@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
```

内嵌了 Tomcat，`java -jar` 一跑就是个能用的 Web 服务。不用再操心容器部署那套，这点对开发体验提升巨大。

## 分层架构：Controller / Service / Repository / Entity

为啥要分层？不分层的代码也能跑，但只要业务稍微复杂点，逻辑全堆在一个类里，改一处崩三处，最后没人敢动。分层是为了把"关注点分开"——每一层只管一件事，出了问题好定位。

经典四层结构：

```
Controller  ← 接 HTTP 请求，做参数校验、调 Service、组装返回
    ↓
Service     ← 业务逻辑的真正归属，事务边界在这一层
    ↓
Repository  ← 跟数据库打交道，增删改查
    ↓
Entity      ← 数据库表的 Java 映射
```

举个用户的例子：

```java
// Entity：对应数据库表
@Entity
@Table(name = "users")
public class User {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String name;
    private String email;
    // getter / setter 省略
}

// Repository：数据库访问
public interface UserRepository extends JpaRepository<User, Long> {
    Optional<User> findByEmail(String email);
}

// Service：业务逻辑
@Service
public class UserService {

    private final UserRepository userRepository;

    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Transactional
    public User create(UserDTO dto) {
        if (userRepository.findByEmail(dto.getEmail()).isPresent()) {
            throw new BizException("邮箱已存在");
        }
        User user = new User();
        user.setName(dto.getName());
        user.setEmail(dto.getEmail());
        return userRepository.save(user);
    }
}
```

几个容易踩的坑：Controller 里别写业务逻辑，它只该做"翻译"——把 HTTP 协议翻译成方法调用，把方法返回翻译成 HTTP 响应。Service 别直接返回 Entity 给前端，字段一变接口就崩，应该有个 DTO 做隔离。Repository 别写太复杂的查询逻辑，实在复杂的交给 Service 或专门的对象去处理。

构造器注入（上面那种写法）比 `@Autowired` 字段注入更好，原因有二：依赖一目了然，单元测试好 new。

## 数据库操作：JPA 还是 MyBatis

Java 这边操作数据库，主流就两条路：JPA（Hibernate 那套）和 MyBatis。选哪个，先把特点弄清楚再决定。

**JPA / Spring Data JPA** 走的是 ORM 路线，把表映射成对象，CRUD 基本不用写 SQL：

```java
public interface UserRepository extends JpaRepository<User, Long> {
    // 光继承就有 save / findById / findAll / delete 这些方法
    // 复杂点的查询用方法名约定或者 @Query
    List<User> findByNameContaining(String keyword);

    @Query("SELECT u FROM User u WHERE u.createdAt > :date")
    List<User> findRecent(@Param("date") LocalDateTime date);
}
```

好处是简单、能跨数据库方言、对象关系映射省心。坏处是一旦查询复杂（多表关联、统计报表），JPQL 写起来别扭，生成的 SQL 也难控制，性能调优不直观。

**MyBatis** 走的是 SQL 手写路线，把 SQL 单独放 XML 或注解里，灵活度极高：

```java
@Mapper
public interface UserMapper {
    @Select("SELECT * FROM users WHERE id = #{id}")
    User findById(Long id);

    @Insert("INSERT INTO users(name, email) VALUES(#{name}, #{email})")
    @Options(useGeneratedKeys = true, keyProperty = "id")
    int insert(User user);
}
```

好处是 SQL 完全可控，复杂报表、性能敏感的查询都能精细打磨，DBA 也看得懂。坏处是简单 CRUD 也得自己写，工作量比 JPA 大。

怎么选？业务模型规整、CRUD 居多、追求开发速度，选 JPA。查询复杂、报表多、对 SQL 性能有强要求，选 MyBatis。国内很多公司是两者混用——简单的用 JPA，复杂的用 MyBatis。没有银弹，看场景。

## 中间件：Redis 和 Kafka 什么时候用

代码写好了，数据能存了，下一步遇到的就是性能和耦合的问题。这时候中间件就该登场了。

**Redis：缓存的首选。** 数据库查询慢，但很多数据其实不怎么变（配置、热门商品、用户信息）。与其每次都查库，不如查出来塞 Redis 里，下次直接读内存。Redis 是纯内存的键值存储，读延迟在亚毫秒级，比查 MySQL 快一两个数量级。

典型用法：

```java
@Service
public class ProductService {

    @Cacheable(value = "product", key = "#id")
    public Product getById(Long id) {
        // 只有 Redis 里没有时才会真正查库
        return productRepository.findById(id).orElseThrow();
    }

    @CacheEvict(value = "product", key = "#product.id")
    public void update(Product product) {
        productRepository.save(product);
    }
}
```

`@Cacheable` 注解配合 Spring Cache + Redis，缓存逻辑基本不用自己写。除缓存之外，Redis 还常用来做分布式锁（`SETNX`）、限流（计数器）、排行榜（ZSet），用处很广。

**Kafka / RocketMQ：消息队列，解耦和削峰。** 同步调用链路太长，下游服务一抖动，上游跟着挂；或者瞬时流量太大，数据库扛不住。引入消息队列，让服务之间异步通信，生产者发完消息就返回，消费者慢慢处理。

举个下单的例子：用户下单后要扣库存、发短信、加积分、推送通知。同步调一遍，任意一个环节慢了用户体验就差。改成发个"订单创建"消息到 Kafka，各服务各自订阅处理，主流程立马返回，响应快了，系统也解耦了。

选型上：吞吐极高、日志/数据流场景偏 Kafka；业务消息、事务消息偏 RocketMQ；中小项目图省事用 RabbitMQ 也行。

## 从单体到微服务

业务刚起步时，一个 Spring Boot 工程把所有功能塞进去就完事——部署简单、调试方便、模块间调用就是方法调用。这叫单体架构，别瞧不起它，很多公司早期都是这么过来的，而且活得挺好。

啥时候该拆？几个信号：

- **代码库大到没人能整体掌握。** 改一处影响一片，merge 冲突天天有。
- **发布互相牵制。** A 模块要上线，被迫把整个单体一起部署，B 模块的 bug 也跟着上了生产。
- **团队扩张，多个团队改同一个仓库。** 协调成本爆炸。
- **部分模块需要独立扩容。** 比如秒杀模块要扛大流量，但其他模块用不到那么多机器。

注意，不是业务一变大就该拆。微服务带来的复杂度是真金白银的成本——分布式事务、服务发现、链路追踪、网络故障……拆之前先掂量团队 hold 不 hold 得住。很多小团队盲目上微服务，最后被运维拖垮。

**Spring Cloud** 是 Java 圈微服务的事实标准（国内常用 Spring Cloud Alibaba 这套）。它解决拆分之后的一堆问题：

- **服务注册与发现**（Nacos / Eureka）：服务实例动态上下线，调用方自动感知，不用硬编码 IP。
- **配置中心**（Nacos Config）：配置统一管理，改配置不用重启服务。
- **服务间调用**（OpenFeign）：像调本地方法一样调远程服务，底层是 HTTP。
- **熔断限流**（Sentinel / Resilience4j）：下游服务挂了别把自己拖死，及时熔断。
- **网关**（Spring Cloud Gateway）：统一入口，做路由、鉴权、限流。

OpenFeign 的写法很直观：

```java
@FeignClient(name = "user-service")
public interface UserClient {
    @GetMapping("/api/users/{id}")
    User getById(@PathVariable Long id);
}

// 调用的时候就像本地方法
User user = userClient.getById(1L);
```

声明式调用，底层的负载均衡、服务发现全自动。拆成微服务后，业务边界清晰了，各服务独立部署、独立扩容，团队可以并行迭代——这就是拆的回报。

## 部署：Docker + jar

Java 应用部署，最朴素的方式是打个 jar 包扔服务器上 `java -jar` 跑起来。生产环境一般不会这么裸跑，会配合 Docker 做容器化。

为啥用 Docker？环境一致性是头一条——"在我机器上能跑"这种事不会再有。镜像把 JDK、应用代码、配置全打包，开发、测试、生产跑的是同一份东西，排查问题方便太多。其次，配合 K8s 之类的编排工具，扩缩容、滚动发布、故障恢复都能自动化。

一个标准的 Spring Boot Dockerfile：

```dockerfile
# 用多阶段构建，减小最终镜像体积
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline
COPY src ./src
RUN mvn package -DskipTests

# 运行阶段，用精简的 JRE 镜像
FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
```

几个细节值得说：用多阶段构建，构建用的 Maven 镜像不会进最终镜像，体积能从几百兆砍到一百多兆。基础镜像选 `alpine` 版本，又小又快。JDK 17 是目前的 LTS 版本，新项目直接上 17 或 21，别再用 8 了。

构建和运行：

```bash
# 打镜像
docker build -t myapp:1.0 .

# 跑起来
docker run -d -p 8080:8080 --name myapp myapp:1.0
```

生产环境再进一步就是上 K8s——把容器编排起来，配健康检查、滚动更新、自动扩缩容。到这一步就进入云原生的领域了，是个更大的话题，这里先不展开。

---

Java 后端这条路，入门的门槛其实在概念多——Spring 那一套、数据库、缓存、消息队列、微服务，每个单拎出来都能学一阵。但只要把这些串起来理解清楚为啥这么设计，后面就是熟练度的事了。先把单体写明白，再去碰微服务；先把 CRUD 跑通，再上中间件。步子别迈太大，技术是为业务服务的，别本末倒置。
