---
title: 大模型 Agent 开发实战：让 AI 真正干活的技术栈
category: agent
platform: agent-llm
tags: ["LLM", "Agent", "MCP", "Claude", "GLM"]
readTime: 18分钟
featured: true
date: 2026-07-28
---

跟 ChatGPT 聊两句、让它写段文案，这事早就不新鲜了。真正有意思的是另一件事：怎么让大模型不是停留在对话框里，而是真的去干活——查数据库、调接口、改代码、跑脚本、把一个复杂任务从头到尾跑完。

这就是 Agent 要解决的问题。这篇把目前实际在用的那套技术栈拆一遍：LLM API 怎么调、Function Calling 怎么接、MCP 是个啥、ReAct 循环怎么转，以及最后落地时模型和框架怎么选。

## 先把概念掰开：Agent 不是聊天机器人

一个普通的大模型调用，本质是 `prompt 进、token 出`，模型本身没有任何外部能力。问它今天北京天气，它要么编一个，要么老实说不知道。

Agent 的核心区别在于**模型能调工具、能多步执行**。模型本身不动手，但它可以决定"我现在需要调用 `get_weather("北京")` 这个函数"，外部程序把这个函数真正跑一遍，把结果塞回给模型，模型再决定下一步干啥。

一句话总结这个范式转变：

- 旧模式：人 → 模型 → 人
- Agent 模式：人 → 模型 → 调工具 → 拿结果 → 模型 → 再调工具 → ... → 最终交付

整个过程中模型扮演的是"大脑"角色，负责规划、决策、整合；脏活累活交给工具干。Claude Code、Cursor、Devin 这些产品，骨子里都是这套。

## LLM API 调用：先把地基打好

Agent 的所有花活，底层都是对 LLM API 的反复调用。所以先把最基础的调用搞清楚。

### 流式输出（SSE）

模型生成 token 是一个一个吐的，等整个回答生成完再返回，用户体验会很卡。几乎所有主流 API 都支持 SSE（Server-Sent Events），服务端一边生成一边推。

用智谱 GLM 的 Python SDK 举例，开启流式就是 `stream=True`：

```python
from zhipuai import ZhipuAI

client = ZhipuAI(api_key="your_api_key")

response = client.chat.completions.create(
    model="glm-4-plus",
    messages=[
        {"role": "user", "content": "用三句话解释什么是 Agent"}
    ],
    stream=True,
)

for chunk in response:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

这段代码的关键在 `for chunk in response`——每来一个 SSE 事件就 print 一小段，肉眼看到的就是模型像打字一样往外蹦字。做 Agent 时这个细节很重要，因为长任务里你需要实时反馈"模型现在在干啥"，而不是干等 30 秒后给一坨。

### Function Calling：让 AI 学会调外部工具

这是 Agent 最核心的能力。流程是这样的：

1. 在调用 API 时，告诉模型"你手头有这些工具可用"，每个工具有名字、描述、参数 schema
2. 模型读到用户问题后，如果判断需要用某个工具，不会直接回答，而是返回一个结构化的"函数调用请求"
3. 外部代码执行这个真正的函数，拿到结果
4. 把结果作为新的 message 喂回模型
5. 模型基于结果继续回答，或者再调下一个工具

看个完整的 GLM Function Calling 例子，让模型查天气：

```python
import json
from zhipuai import ZhipuAI

client = ZhipuAI(api_key="your_api_key")

# 真正干活的函数
def get_weather(city: str) -> str:
    # 实际项目里这里是调天气 API
    fake_data = {"北京": "晴 28度", "上海": "多云 25度"}
    return fake_data.get(city, "未知")

tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "查询指定城市的实时天气",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {
                        "type": "string",
                        "description": "城市名，比如 北京、上海"
                    }
                },
                "required": ["city"]
            }
        }
    }
]

messages = [{"role": "user", "content": "北京今天天气怎么样？穿什么合适？"}]

# 第一轮：模型决定调工具
response = client.chat.completions.create(
    model="glm-4-plus",
    messages=messages,
    tools=tools,
    tool_choice="auto",
)

assistant_msg = response.choices[0].message
messages.append(assistant_msg)

# 检查模型是不是要调函数
if assistant_msg.tool_calls:
    for tool_call in assistant_msg.tool_calls:
        func_name = tool_call.function.name
        args = json.loads(tool_call.function.arguments)

        # 真正执行
        if func_name == "get_weather":
            result = get_weather(**args)
        else:
            result = "未知函数"

        # 把结果塞回去
        messages.append({
            "role": "tool",
            "tool_call_id": tool_call.id,
            "content": result,
        })

    # 第二轮：模型基于工具结果给最终回答
    final = client.chat.completions.create(
        model="glm-4-plus",
        messages=messages,
        tools=tools,
    )
    print(final.choices[0].message.content)
```

跑完这段，输出大概是：

> 北京今天晴，气温 28 度。建议穿短袖、薄衬衫，体感较热可以选透气材质。

整个流程里，模型自己判断出"我需要先查天气"，然后调 `get_weather`，拿到结果后再综合给出穿衣建议。这就是 Agent 干活的最小闭环——把这个循环跑起来，理论上模型就能调用任意工具。

## MCP 协议：工具市场的 USB-C 接口

Function Calling 有个现实问题：每个模型厂商的 API 格式略有不同，每个项目都得手写一遍工具接入逻辑。你写了个查数据库的工具给 GLM 用，换到 Claude 又得改一遍，换成 GPT 再改一遍。

Anthropic 在 2024 年底搞了个标准叫 **MCP（Model Context Protocol）**，专门解决这个问题。它的定位非常清晰——**AI 世界的 USB-C 接口**：工具实现一次，所有支持 MCP 的客户端（Claude Desktop、Cursor、Cline、ZCode 等）都能用。

### 三类能力

MCP server 对外暴露三种东西：

- **Tool**：可被模型调用的函数。比如 `query_db(sql)`、`send_email(to, subject)`。这是最常用的，对应 Function Calling。
- **Resource**：可被读取的数据源。比如一个文件、一个 API 返回的 JSON、一段文档。模型按需读取。
- **Prompt**：预设的提示词模板。把高频使用的复杂 prompt 沉淀下来复用。

实际开发中 90% 的场景只用 Tool，Resource 和 Prompt 看场景用。

### 两种传输方式

- **stdio**：server 作为子进程跑在本地，通过标准输入输出通信。适合本地工具（操作文件、跑命令、连本地数据库）。零网络开销、最简单。
- **HTTP（Streamable HTTP）**：server 是个独立 HTTP 服务，可以远程部署。适合团队共享、需要鉴权、跨机器调用的场景。

本地开发优先 stdio，要给别人用就上 HTTP。

### 一个最小的 MCP Server

用官方 Python SDK 写一个查时间的 MCP server，三十行代码搞定：

```python
# pip install mcp
from mcp.server.fastmcp import FastMCP
import datetime

mcp = FastMCP("time-server")

@mcp.tool()
def get_current_time(timezone: str = "UTC") -> str:
    """获取当前时间，可指定时区（如 Asia/Shanghai）"""
    tz = datetime.timezone(datetime.timedelta(hours=8)) if "Shanghai" in timezone else datetime.timezone.utc
    now = datetime.datetime.now(tz)
    return now.strftime("%Y-%m-%d %H:%M:%S %Z")

@mcp.tool()
def days_between(start: str, end: str) -> int:
    """计算两个日期之间相隔多少天，格式 YYYY-MM-DD"""
    fmt = "%Y-%m-%d"
    d1 = datetime.datetime.strptime(start, fmt)
    d2 = datetime.datetime.strptime(end, fmt)
    return abs((d2 - d1).days)

if __name__ == "__main__":
    mcp.run(transport="stdio")
```

把这个文件存成 `server.py`，然后在 Claude Desktop 或任何支持 MCP 的客户端配置一下：

```json
{
  "mcpServers": {
    "time": {
      "command": "python",
      "args": ["/abs/path/to/server.py"]
    }
  }
}
```

启动后，模型就能看到 `get_current_time` 和 `days_between` 这两个工具，用户问"现在几点"或者"距离 2026 年元旦还有几天"，模型会自动调用对应工具。

工具开发者从此只写一遍逻辑，谁都能接。这就是 MCP 想干的事。

## Agent 工作流：让模型自己跑起来

工具准备好了，下面是组织"模型怎么用这些工具"的工作流。最经典的是 ReAct。

### ReAct 循环

ReAct = Reasoning + Acting，核心是让模型**交替进行"思考"和"行动"**。每一轮模型先输出一段思考（"我需要先查数据库拿到用户列表"），再决定调哪个工具（Action），拿到 Observation 后进入下一轮思考，直到能给出最终答案。

一个典型的 trace 长这样：

```
用户：帮我统计上周销售额最高的三个商品

思考：需要先查上周的销售记录
行动：调用 query_sales(date_range="last_week")
观察：返回 1247 条销售记录

思考：需要按商品聚合算总额并排序
行动：调用 aggregate(records, group_by="product", order_by="amount desc")
观察：商品A 8.2万、商品B 6.5万、商品C 4.1万...

思考：已经拿到前三，可以回答了
最终回答：上周销售额前三的商品是 A、B、C，分别是 8.2 万、6.5 万、4.1 万
```

把这套循环写成代码，骨架大概是这样：

```python
def react_loop(user_query, tools, max_steps=10):
    messages = [{"role": "user", "content": user_query}]

    for step in range(max_steps):
        # 模型思考 + 决定调哪个工具
        resp = call_llm(messages, tools)
        messages.append(resp.message)

        # 没有工具调用，说明模型给出了最终答案
        if not resp.message.tool_calls:
            return resp.message.content

        # 执行所有工具调用，结果塞回 messages
        for tool_call in resp.message.tool_calls:
            result = execute_tool(tool_call)
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result,
            })

    return "达到最大步数，任务未完成"
```

`max_steps` 这个参数很关键。没有上限，模型偶尔会陷入死循环反复调同一个工具，烧 token。

### 多步任务拆解

复杂任务不是一轮 ReAct 能搞定的。比如"分析这份 100 页的财报 PDF，写一份 3000 字投资分析报告"，里面有几十个步骤。常见的两种思路：

**Plan-then-Execute**：先让模型规划出完整步骤列表，再依次执行。优点是流程清晰可审计，缺点是计划往往赶不上变化，中间某步结果跟预期不一致时整个计划会乱。

**ReAct with Reflection**：边做边调整，每完成几步让模型回顾一下当前进展，决定是继续原路还是改方向。更灵活，但 token 消耗大、容易跑偏。

实际工程里两种结合用：先用一轮 plan 出大致框架，执行过程中允许模型动态调整子步骤。

### Subagent 并行

单个 Agent 串行做所有事，慢且容易上下文爆炸。复杂任务拆成多个子 Agent 并行干，每个子 Agent 有自己的上下文和工具集，干完把结果汇总给主 Agent。

举个例子，做代码 review 的 Agent：

- 主 Agent：负责拆解 PR、分派任务、汇总结论
- Subagent A：跑测试，检查覆盖率
- Subagent B：检查代码风格、安全漏洞
- Subagent C：分析改动对历史模块的影响

A、B、C 同时跑，最后主 Agent 拿三份报告写最终的 review 意见。这比串行一个一个跑快得多，而且每个子 Agent 上下文干净，不会因为历史太长导致能力下降。

Claude Code 的多 Agent 架构、Cursor 的后台任务，用的都是这套思路。

## 实际应用场景

### AI 编程助手

Claude Code、Cursor 这类工具是 Agent 范式最成功的落地。原理拆开看：

- **工具集**：读文件、写文件、跑 shell 命令、搜索代码库、调 LSP 拿类型信息
- **工作流**：用户提需求 → Agent 读相关代码 → 规划改动 → 调工具改代码 → 跑测试验证 → 出问题再改
- **上下文管理**：用 embedding 检索相关代码片段，避免把整个仓库塞进 prompt

关键在于"跑测试验证"这一步。差的 Agent 改完代码就交差，好的 Agent 会自己跑 `pytest`，看到失败就再修，形成自我纠错循环。这就是 Agent 比单纯代码补全强的地方——它能把活干完，而不只是给建议。

### 自动化文档生成

给 Agent 一堆源码或 API 定义，让它生成文档：

```
工具：read_file、list_functions、extract_docstring、run_docstring_examples
流程：
1. 扫描指定目录所有 .py 文件
2. 提取每个函数签名 + 已有 docstring
3. 缺失的让模型基于代码生成
4. 跑一遍示例代码，确认能跑通
5. 输出 Markdown / Sphinx 格式
```

这类任务 Agent 的优势在于"看代码 + 跑代码"双管齐下，生成的文档是经过实际验证的，比纯靠模型脑补靠谱。

### 数据分析 Agent

典型的数据 Agent 工作流：

- 工具：`run_sql(query)`、`plot(data)`、`statistical_test(a, b)`
- 用户问"上个月华东区销售额为什么下降"，Agent 自己写 SQL 查数据、画图、做对比检验、最后写一份带图表的分析报告

核心难点不是模型能力，而是工具的可靠性。SQL 写错、字段名拼错、数据类型不对——这些细节决定 Agent 是不是真能用。所以做数据 Agent 的人大部分精力在打磨工具，而不是调 prompt。

## 技术选型建议

### 模型选择

跑 Agent 这事对模型有特殊要求，不是越大越好。关键看三点：**Function Calling 准确率、长上下文稳定性、推理能力**。

- **GLM-4 系列（智谱）**：国产首选。Function Calling 支持完整、中文场景表现好、价格友好、合规无障碍。做国内业务、对接企业内部系统的 Agent，首选。API 兼容 OpenAI 格式，迁移成本低。
- **GPT-4o / o1（OpenAI）**：综合能力强、生态成熟、Function Calling 准确率高。缺点是国内访问不便、贵、数据合规要求高的场景不能用。
- **Claude 3.5 / Claude 4（Anthropic）**：长上下文处理、代码任务、复杂推理是强项。MCP 是 Anthropic 主推的，用 Claude 跑 MCP 工具链最顺。做编程 Agent、长文档处理这类场景很合适。

实操建议：手里至少备两个模型做 fallback。一个主力（比如 Claude 或 GPT-4o），一个备用（GLM），主力 API 抽风或者限流时自动切。

### 框架选择

这块水很深，常见的几条路：

**LangChain / LangGraph**：功能全、生态大，是入门首选。但抽象层很厚，简单需求也得绕一堆封装，调试痛苦。适合做 PoC、快速验证想法，生产环境慎用——很多团队最后都把 LangChain 重写掉。

**直接调 API**：不依赖任何框架，自己用 `requests` 或厂商 SDK 拼 messages 数组、管理工具调用循环。最灵活、最透明、最好调，缺点是循环逻辑、错误处理、重试、并发这些得自己写。中等复杂度的 Agent 强烈推荐这条。

**自研轻量框架**：在直接调 API 基础上，把 ReAct 循环、工具注册、上下文管理封装成内部库。长期看性价比最高，团队越大越值。多数成熟的 AI 团队最后都走到这一步。

**专门的 Agent 框架（如 AutoGen、CrewAI）**：多 Agent 协作场景可以考虑，但生态还不稳定，API 变动频繁，踩坑成本高。

给个粗暴的决策树：

- 想三天跑出 demo：LangChain
- 上线一个生产 Agent：直接 API + 自研
- 团队要做十个 Agent：自研轻量框架
- 多 Agent 复杂协作：AutoGen / CrewAI 试水，但做好替换准备

## 几个实战踩坑

最后送几条真实项目里反复出现的教训。

**Token 是会爆的**。Agent 多轮调用、工具返回大数据，上下文很容易冲到几十万 token，既慢又贵。一定要做上下文压缩——历史消息定期摘要、工具返回大结果先 truncate、无关消息直接删。

**工具描述写不好，模型就不会用**。模型决定调哪个工具，完全看 `description` 那段话。描述模糊、参数 schema 不清晰，模型要么乱调要么不调。把每个工具当成 API 文档来写，参数取值范围、返回格式、错误情况都说清楚。

**别让模型直接跑危险操作**。删文件、发邮件、调付款接口这类，一定要加确认环节或者权限边界。Agent 偶尔会"自信地"做傻事，比如执行用户随口说的"把所有旧数据清掉"——你不会想知道后果。

**Function Calling 不是万能的**。简单结构化调用很准，参数多了或者逻辑复杂了，模型会瞎填参数。复杂参数尽量拆成多个简单工具，每个工具参数不超过 3-4 个。

**流式输出要做容错**。SSE 偶尔会断连、会返回半截 JSON，生产代码必须处理这些情况，否则一个网络抖动整个 Agent 就挂了。

---

Agent 这块技术栈变化极快，半年前的最佳实践现在可能已经过时。但底层的几个东西是稳的：Function Calling 的调用循环、MCP 这种工具标准化协议、ReAct 的思考-行动范式。把这些吃透，新框架新模型冒出来也能很快上手。

把工具准备好，把循环跑通，剩下的就是反复打磨——让 AI 真正干活这事，难的不是某个炫技功能，而是把每一轮调用、每一个工具、每一次错误处理都做到稳。
