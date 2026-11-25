# 发布与同步流程

目标链路：

```
GitHub 仓库（源码真相）
      │  push
      ├──► raw.githubusercontent.com  ← 用户/旧版本从这里自动更新
      │
      └──► GitHub Webhook ──► Greasy Fork 条目（流量入口）
                               （5 分钟后拉取，因为 raw 有 CDN 缓存）
```

## 一、GitHub

### 首次

```bash
cd E:/workspace/ykt-ai-trainer
git init
git add .
git commit -m "feat: 雨课堂 AI 陪练自动答题脚本 v1.0.0"
git branch -M main
git remote add origin https://github.com/beeeeeeef/ykt-ai-trainer.git
git push -u origin main
```

仓库需要在网页上先建好（public），不要勾选任何初始化文件。

### 每次改版

1. 改 `trainer.user.js`
2. **把 `@version` 加一**（如 `1.0.0` → `1.0.1`）—— 不改版本号，已装用户永远不会更新
3. `git commit` + `git push`
4. 等约 5 分钟让 raw 的 CDN 缓存刷新

## 二、Greasy Fork 首次发布

1. 注册并登录 <https://greasyfork.org/zh-CN>
2. 右上「发布脚本」→ 直接把 `trainer.user.js` 全文粘进去
3. 填写：脚本名、描述、语言、脚本类别、许可证（MIT）
   - 「适用的网站」会自动从 `@match` 推导，不用手填
4. 提交，等审核（新账号首次发布通常要等一会儿）
5. 通过后得到 `https://greasyfork.org/zh-CN/scripts/<id>-<slug>` 形式的页面

> 这一步只是为了让条目存在。源码不用在 GF 上维护，下一步接上 GitHub 同步后，网页上改代码会被同步覆盖。

## 三、接上同步（关键）

### 1. 在 GF 上设置同步源

脚本页 → **Admin（管理）** → Sync（同步）区域：

- 同步地址填：
  ```
  https://raw.githubusercontent.com/beeeeeeef/ykt-ai-trainer/main/trainer.user.js
  ```
- 同步类型选 **Webhook**（推送即同步）

### 2. 在 GF 上生成密钥

用户页 → **Webhooks**（<https://greasyfork.org/zh-CN/users/<你的用户 id>/webhook>）

- 生成 secret（**只显示一次**，记下来）
- 页面会给出 payload URL，形如：
  ```
  https://greasyfork.org/zh-CN/users/123456-beeeeeeef/webhook
  ```

### 3. 在 GitHub 上配 Webhook

仓库 → Settings → Webhooks → Add webhook：

| 字段 | 值 |
|---|---|
| Payload URL | 上一步 GF 给的地址 |
| Content type | `application/json` |
| Secret | 上一步 GF 生成的密钥 |
| Which events | **Just the push event** |

### 4. 验证

push 一次改动（记得升版本号），5~10 分钟后看 GF 脚本页版本号是否跟上。GF 的 Admin 页也有「Update and sync now」可手动触发，不用等。

## 之后的日常

只做一件事：**改代码 → 升 `@version` → `git push`**。GF 会自己跟随。

## 坑

- **`@version` 不加等于没发**：Tampermonkey 靠版本号比较，代码改了版本没改，已装用户收不到。
- **raw 有约 5 分钟 CDN 缓存**：GF 的 webhook 同步为此故意延迟 5 分钟才拉。
- **同步只拉代码文件**，README、LICENSE 不会同步到 GF；GF 上的描述可以单独维护，也能配「同步附加信息」。
- **GF 禁止混淆/压缩过的代码**，要保持可读。
- **webhook 按仓库匹配脚本**：sync 地址必须指向上一步那个仓库，否则 GF 收到推送后找不到对应脚本。
- **撤回不彻底**：删 GF 条目或把 GitHub 转私有，已经装到别人浏览器里的副本照样运行。真要能远程关停，得在脚本开头加状态检查（拉一个 `status.json`，`{"enabled":false}` 就自动禁用）。
- **单文件仓库可以把 sync 指向 `main`**；一旦以后加了构建步骤（TypeScript 编译等），就要改成「`main` 开发 + `release` 分支只放产物」，sync 指向 `release`，否则每次半成品提交都会推给用户。
