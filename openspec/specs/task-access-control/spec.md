# task-access-control Specification

## Purpose

通过完整关联授权约束资源、动作、访问身份和处理目的地，将任务协调权与直接操作权分开，并在实际动作与内容传输时判断当前授权而非信任模型或配置快照。

## Requirements

### Requirement: Associated grant constraints
系统 SHALL 保留资源、动作、身份、目标和范围的关联条件，Bundle 引用和主机登录态不得创造授权。

#### Scenario: Cross product
- **WHEN** 授权 A 只读 X、B 写 Y
- **THEN** 不能推导 A 写 X

#### Scenario: Copied bundle
- **WHEN** 其他频道引用 Bundle 但无连接使用权
- **THEN** 工具访问被拒绝

### Requirement: Current action and destination authorization
系统 SHALL 在动作、读取和内容转移时检查当前 Grant、接收身份、设备和模型目的地。

#### Scenario: Revoked source
- **WHEN** 授权在上下文创建后撤回
- **THEN** 新调用和读取被拒绝

#### Scenario: Unapproved embedding
- **WHEN** 主模型获准但 embedding 端点未获准
- **THEN** 不向该端点发送内容

### Requirement: Access identity defaults
系统 SHALL 群组默认选择合法服务身份，私聊默认合法个人身份；显式覆盖验证授权且不静默借用其他账号。

#### Scenario: Missing service connection
- **WHEN** 群组没有适用服务连接
- **THEN** 返回缺失条件，不使用发起者个人登录态

### Requirement: Separate coordination authority
系统 SHALL 分别判断协调资格和直接操作限制，子授权不超过父任务与当前来源授权。

#### Scenario: Read only coordinator
- **WHEN** Aida 无直接写权但可委派合法代码工作
- **THEN** 其自行写被拒绝，指定成员可按范围执行
