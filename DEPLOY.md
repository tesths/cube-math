# 部署指南 · cube-views（正方体三视图教具）

> 本文写给「不是专业运维」的老师：照着一步步点，就能把网站放到公网上，
> 学生用手机/平板扫码打开，老师在自己电脑上看 8 个组同步。
>
> 仓库里已经准备好的东西：`vercel.json`（静态站点 + 无服务器函数）、`api/`（接口）、
> `lib/store.js`（存储）、`Dockerfile` + `railway.json`（Railway）、`public/`（纯静态前端）。

---

## 0. 先选一个方案

| 方案 | 适合场景 | 优点 | 缺点 |
|---|---|---|---|
| **方案一：整体上 Vercel**（推荐） | 想彻底摆脱海外服务器绕路，有 GitHub 账号 | 免费、免运维、香港节点（`hkg1`）、静态资源全球 CDN | 无 SSE → 每 2 秒轮询；需要 Redis；国内直连 `vercel.app` 可能不稳（绑自定义域名好转） |
| 方案二：Railway | 想要「秒级实时」和真正的磁盘存储 | 支持 SSE、数据写磁盘、零额外服务 | 免费额度有限；新加坡节点从国内绕路（之前遇到的问题） |
| 方案三：前端 Vercel + 后端 Railway | 页面要快、实时性也要 | 静态资源走 CDN，实时性靠 Railway | 要维护两个平台、两个域名，要配 `apiBase` 和 CORS |

只上课堂局域网（一台电脑 `npm start`，同一个 Wi-Fi）不用看本文，见 `README.md`。

---

## 方案一：整体部署到 Vercel（推荐）

### 1.1 前置：先有 GitHub 仓库

Vercel 从 Git 仓库自动部署，所以代码得先在 GitHub 上。

1. 注册/登录 GitHub（<https://github.com>）。
2. 新建仓库：**New repository** → 名字随意（如 `cube-views`）→ **Private** 或 Public 都行 → **Create**。
   不要勾选 README / .gitignore 模板（本地已经有了）。
3. 在项目目录上传代码（二选一）：
   - **图形化（推荐给非程序员）**：装 [GitHub Desktop](https://desktop.github.com/) →
     **Add existing repository** → 选中 `cube-views` 文件夹 → **Publish repository**。
   - **命令行**：

     ```bash
     cd cube-views
     git init
     git add .
     git commit -m "cube-views"
     git branch -M main
     git remote add origin https://github.com/<你的用户名>/cube-views.git
     git push -u origin main
     ```

   > 注意：`.env`、`node_modules/`、`data/`、`shots/` 已经在 `.gitignore` 里，不会被传上去。
   > 不要为了图省事把 `.env` 提交上去（里面有 Redis 令牌）。
   >
   > ⚠ Vercel 免费版（Hobby）**不支持连接「Git 组织（Organization）名下的仓库」**，
   > 请把仓库建在你的**个人账号**下，或者先把仓库 Fork/转移到个人账号。

### 1.2 在 Vercel 导入项目

1. 用 GitHub 账号登录 <https://vercel.com>（**Sign up → Continue with GitHub**）。
2. 点 **Add New… → Project**，找到刚推上去的 `cube-views` 仓库，点 **Import**。
3. 配置页只需要确认这几项（其余保持默认）：

   | 项目 | 填什么 |
   |---|---|
   | Framework Preset | **Other**（本项目没有构建步骤） |
   | Root Directory | 默认 `./`；如果 `vercel.json` 在子目录里，就选那个子目录 |
   | Build Command | **留空**（不要填 `npm run build`，本项目没有 build 脚本） |
   | Output Directory | `public`（`vercel.json` 里已经写了，页面上留空也会生效） |
   | Install Command | `npm install --omit=dev`（`vercel.json` 里已经写了） |
   | Environment Variables | 先跳过，下一步配 Redis 后会自动注入；也可以现在手填（见 1.4） |

4. 如果先点了 **Deploy** 也没关系：这一步会先跑起来，只是**还没配 Redis**，
   多个函数实例之间不同步（页面能开，但 8 个组互相看不到）。配完 Redis 重新部署即可。

### 1.3 一键安装 Upstash Redis（Vercel Marketplace）

Vercel 没有可写磁盘、函数实例之间也不共享内存，所以 8 个组要互相同步，**必须有 Redis**。
最省事的方式是从 Vercel 的 Marketplace 装：会自动把连接信息注入成环境变量。

1. 项目页 → 顶部 **Storage** 标签 → **Create Database** → 选 **Upstash**（Marketplace）。
2. 数据库配置：
   - **Name**：`cube-views-redis`；
   - **Primary Region**：**Singapore（AWS ap-southeast-1）**。
     Upstash 没有香港可用区；对国内用户来说新加坡最近、最稳。
     如果你更相信东京线路，也可以选 **Tokyo（ap-northeast-1）**。
   - Plan：**Free**。
3. 创建后在 **Projects / Connect Project** 里把它连到 `cube-views` 项目，
   环境变量会自动注入（`KV_REST_API_URL`、`KV_REST_API_TOKEN` 等）。
4. **重新部署**一次（Deployments → 最新一条 → ⋯ → **Redeploy**），让函数读到新的环境变量。

> 为什么数据库选新加坡、函数选香港（`hkg1`）？国内老师 → 香港节点延迟最低；
> 香港 → 新加坡一个来回约 30–50 ms，每次轮询只查一次 Redis，课堂上感觉不出来。
> 想再压一点延迟，可以把 `vercel.json` 里的 `regions` 改成 `["sin1"]`，与数据库同区，
> 但学生/老师端的请求就都绕到新加坡去了——**国内访问还是 hkg1 更好，不建议改**。

### 1.4 确认环境变量（这是最容易漏的一步）

项目 → **Settings → Environment Variables**，确认存在下面**任意一套**（本项目两套都认）：

| 变量名 | 说明 |
|---|---|
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Vercel Marketplace / Upstash 集成自动注入（最常见） |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | 直接从 Upstash 控制台复制（REST API 那一栏） |

要点：

- **不要用 `KV_REST_API_READ_ONLY_TOKEN`**：它是只读令牌，写不进去，学生提交会失败。
- 变量默认作用于 Production / Preview / Development 三个环境，保持默认即可。
- **改完环境变量一定要 Redeploy**，正在运行的函数不会自动读到新值。
- 想确认到底用的是哪套：打开 `/api/state` 正常、且 Upstash 控制台 **Data Browser** 里出现
  `cube-views:g1` 这样的键，就说明写进 Redis 了。

### 1.5 部署完的验证清单（逐条打勾）

把 `<你的域名>` 换成 Vercel 给的地址，例如 `https://cube-views-xxx.vercel.app`。
用手机和电脑各开一个，效果更真实。

1. **首页**：打开 `https://<你的域名>/` → 先出现「你是第几组？」的选组页（8 个大按钮）。
   点一个组号 → 进入工作区（左工具 / 中间方格纸 / 右侧「看三视图」），不白屏。
   选完就锁定在这一组，刷新不会回到首页；换组见文末「清空/重置」一节。
2. **教师端**：打开 `https://<你的域名>/teacher` → 8 个小组的卡片面板。
3. **接口 1**：打开 `https://<你的域名>/api/state` → 一段 JSON，包含
   `"groupCount": 8` 和 `"groups": [...]`。
4. **接口 2（健康检查）**：打开 `https://<你的域名>/api/healthz` →
   `{"ok":true,"groups":8,"region":"hkg1",...}`。
   `region` 是 `hkg1` 就说明函数真的跑在香港。
5. **接口 3（SSE 降级）**：命令行执行

   ```bash
   curl -i https://<你的域名>/api/events
   ```

   → 立刻返回 `HTTP/2 204`，响应头里有 `cache-control: no-store` 和 `x-sse-unavailable: 1`。
   前端看到这个就会自动切「每 2 秒轮询」，不用你设置。
6. **接口 4（ETag / 304）**：

   ```bash
   # 取真实 ETag（不要照抄示例值，每份数据算出来都不一样）
   ETAG=$(curl -si https://<你的域名>/api/state | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
   echo "ETag=$ETAG"
   curl -si -H "If-None-Match: $ETAG" https://<你的域名>/api/state | head -1
   ```

   → 第二条应该是 `HTTP/2 304`，并且没有响应体（省流量）。
   注意：**数据没变**时才会 304；如果两次之间有人改了方块，会正常返回 200。
7. **函数真的在香港**：

   ```bash
   curl -sI https://<你的域名>/api/healthz | grep -i x-vercel-id
   ```

   → 类似 `x-vercel-id: hkg1::hkg1::xxxx`，开头的区域码应为 `hkg1`。
8. **两台设备互看同步（最关键）**：
   - 学生端（手机或另一台电脑）打开 `/`，点自己的组号进工作区，摆几个方块；
   - 方块是**自动保存**的（右上角会出现「已保存 HH:MM:SS」），没有「提交」按钮；
   - 教师端（你的电脑）打开 `/teacher`，**2–3 秒内**该组卡片更新出同样的图形；
   - 教师端没有「清空」按钮；要清空某一组用：
     `curl -X POST https://<你的域名>/api/groups/3/clear`（或学生端点两次「全部清空」）；
   - 两个设备都断网再恢复 → 页面自己会重连/继续轮询，不用刷新。
9. **数据真持久**：在 Upstash 控制台 → 你的数据库 → **Data Browser**，
   能看到 `cube-views:g1` … `cube-views:g8` 的键；然后 Vercel **Redeploy** 一次，
   刷新教师端，刚才摆的图形还在（因为在 Redis 里，不在函数内存里）。

### 1.6 区域：`hkg1` 与各套餐的差别

`vercel.json` 里已经写死：

```json
"regions": ["hkg1"]
```

- `hkg1` = Vercel 的香港节点（底层 AWS `ap-east-1`）。国内老师/学生访问比默认的
  美国华盛顿（`iad1`）近得多，这正是这次从 Railway 新加坡迁过来的原因。
- **套餐限制**（Vercel 官方规则）：**Hobby 免费版只能选 1 个区域**；Pro 最多 5 个；
  Enterprise 全部 19 个。所以「`regions` 里只写一个区域」在免费版是合法的；
  写成两个以上会导致部署直接失败。
- 也可以在 **项目 → Settings → Functions → Function Regions** 里用下拉框改（会覆盖
  `vercel.json`）。改完要重新部署才生效。
- 顺带说明：静态文件（HTML/JS/图片）走 Vercel 全球 CDN，本来就在离学生最近的
  边缘节点上，**不受 `regions` 影响**；`regions` 只决定 `/api/*` 这些函数在哪里跑。

### 1.7 中国大陆访问：`vercel.app` 可能不稳，建议绑自定义域名

这一条最需要心理准备：

- `xxx.vercel.app` 这个域名在国内**时不常**能直接打开（DNS 解析被污染、线路绕行、
  部分运营商时通时断）。教室网络差的时候会表现为「白屏 / 一直转圈 / 偶发 504」。
- **建议：绑一个自己的域名**（例如 `cube.your-school.cn`）。经验上自定义域名走的是
  正常的 Anycast 线路，比 `*.vercel.app` 稳定得多。步骤：
  1. 在任意注册商买一个域名（阿里云/腾讯云/Cloudflare 都行，几十元/年）；
  2. 项目 → **Settings → Domains → Add**，填域名；
  3. 按 Vercel 的提示去域名服务商加解析：
     - 用子域名：加一条 **CNAME** 指向 `cname.vercel-dns.com`；
     - 用根域名：把 NS 改成 Vercel 给的名称服务器，或加 A 记录（Vercel 页面会给出具体值）；
  4. 等 5 分钟到几小时生效，Vercel 自动签发 HTTPS 证书（免费）。
- 备案说明：Vercel 的服务器在境外（香港/新加坡），**域名解析到境外服务器通常不需要
  ICP 备案**；但域名注册商可能要求实名认证。若以后改在国内云主机上跑，就需要备案了。
- 上线前**一定在真实教室网络里试一次**（老师的电脑 + 学校 Wi-Fi + 学生手机流量各试一遍）。
  如果学校网络对境外域名做了拦截，任何境外平台都救不了——这种情况用下面的
  「方案三 + 国内云」或课堂局域网方案。

### 1.8 免费额度与成本（按一个班 9 台设备估算）

先说结论：**一个班、每周几节课，免费额度基本够；如果每周课很多，Upstash 的
按量付费很便宜，可以先免费、不够再升。**

课堂量级估算（8 个学生端 + 1 个教师端，降级轮询每 2 秒一次）：

| 指标 | 估算 | 免费额度 | 结论 |
|---|---|---|---|
| 函数调用 | ≈ 4.5 次/秒 → 45 分钟一课约 **1.2 万次** | Vercel Hobby **100 万次/月** | ≈ 80 节课/月 |
| 流量 | 每次响应几 KB，一课约 **20 MB** | Vercel Hobby **100 GB/月** | 绰绰有余 |
| Redis 命令 | 每台设备每 2 秒 1 条 `MGET`（一次查询取回 8 个组） → 一课约 **1.2 万条** | Upstash 免费版 **50 万条/月** | ≈ 40 节课/月 |
| Redis 存储 | 8 个键，每个最多几百字节 | 免费版 250 MB | 4 个数量级的余量 |

- 超过 Upstash 免费额度后：把数据库切到 **Pay-As-You-Go**（$0.20 / 10 万条命令），
  一课大约 **2 分钱**；记得在 Upstash 控制台设 **Monthly Budget**，到达上限只会限流不会乱扣钱。
- Vercel 免费版（Hobby）**仅限个人非商业用途**；课堂教学属于非商业，没问题。
- 费用以官网为准：<https://vercel.com/pricing>、<https://upstash.com/pricing/redis>。

### 1.9 Vercel 方案已知限制（避免课上踩坑）

1. **没有 SSE 实时推送**：前后端都做了兜底（`/api/events` 立即 204；即使某个代理接住了连接
   却一直不推数据，前端 3 秒收不到第一帧也会切轮询），所以看到的是「2 秒级同步」而不是「毫秒级」。
   课堂够用。轮询间隔可以在 `public/config.js` 的 `pollMs` 调整。
2. **函数冷启动**：一段时间没人访问后第一次请求会慢 0.3–1 秒。上课前先自己打开一次
   `/teacher` 预热即可。
3. **部署/重启会清空函数内存**：所以必须靠 Redis 存数据（见 1.3）。
4. **Redis 抖一下不会整站挂**：`lib/store.js` 里给每个 Redis 请求加了 3 秒超时，
   失败时自动降级成「函数内存存储」并且只警告一次。但降级期间**不同函数实例之间可能不同步**，
   所以看到日志里出现 `Redis 不可用（...），已降级为进程内存存储` 时，尽快去 Upstash 看是不是
   额度用完 / 数据库被暂停 / 环境变量填错。
5. **免费版单实例限制**：同一账号同时只能有 1 个部署在跑构建（并发部署 1），改完代码连续
   push 多次时后几次会排队，属正常现象。

### 1.10 304 已在前端生效（无需再改）

`/api/state` 支持 ETag + `If-None-Match` → `304`，前端 `public/js/shared/net.js` 已经接上了：

- 轮询时把上一次响应的 `ETag` 存下来，下次带 `If-None-Match`；
- 收到 `304` 时**沿用上一次的 JSON**，并单独判断（`res.ok` 对 304 是 `false`，
  不做特殊处理会误报"连接断开"）；
- 页面切到后台时暂停轮询，切回前台立刻补一次。

本地可以验证：`npm run verify:serverless` 会起一个"没有 SSE、带 ETag"的模拟后端，
真的用浏览器跑一遍，并统计 200/304 次数（要求至少命中一次 304）。

轮询间隔可以在 `public/config.js` 里改 `pollMs`（默认 2000ms）。免费版 Upstash 的命令数有限，
课多的话调到 3000~5000 能省一半以上，代价是老师看到更新晚 1~3 秒。

---

## 方案二：Railway（原有方案，含实时 SSE）

仓库里已有 `Dockerfile` 和 `railway.json`，Railway 会自动识别，不需要改任何代码。

1. 代码推到 GitHub（见 1.1）。
2. <https://railway.app> 用 GitHub 登录 → **New Project → Deploy from GitHub repo** → 选仓库。
3. 项目里 **New → Volume**，挂载到 **`/data`**（`Dockerfile` 里 `DATA_DIR=/data`，挂上就不会丢数据）。
4. 环境变量：通常什么都不用填（`PORT` 由 Railway 自动注入）。
   如果前端在别的域名上，建议加 `CORS_ORIGIN=https://<前端域名>`。
5. **Settings → Networking → Generate Domain** 生成公网地址。
6. 验证：`https://<railway域名>/healthz` 返回 `{"ok":true,"groups":8}`；
   `/teacher` 能打开；两台设备同步是**秒级**（有 SSE，不轮询）。
7. 区域：Railway 可选的亚洲区主要是 **Singapore**，从国内访问会比香港慢一些——
   这正是当初改用 Vercel 的原因。如果又想要实时又想要香港，需要自己找香港 VPS（见下面的兜底方案）。

> Railway 的免费/试用额度按小时计费，用超了会停机；长期上课建议至少选最小付费档。

---

## 方案三：前端放 Vercel + 后端放 Railway（两者兼得）

思路：页面（HTML/JS/图片）放 Vercel 走 CDN，快；实时同步和存储交给 Railway，有 SSE。

1. 先按**方案二**把后端跑起来，拿到地址，例如 `https://cube-views.up.railway.app`。
2. 在 Railway 后端加环境变量 `CORS_ORIGIN=https://<你的 Vercel 域名>`（默认 `*` 也能用，
   生产环境建议收紧）。**注意 CORS 只影响跨域，和 SSE 无关**。
3. 改 `public/config.js`（这是前端同学的文件）：

   ```js
   window.CUBE_VIEWS_CONFIG = { apiBase: 'https://cube-views.up.railway.app' };
   ```

4. push → Vercel 自动部署 → 打开 `https://<你的 Vercel 域名>/`：
   页面从 Vercel 加载，数据请求发到 Railway，实时性恢复成秒级。
5. 临时验证不用改文件，也可以在网址后面加 `?api=https://...` 覆盖。
6. 如果所有东西都在 Vercel 上，`config.js` 里 `apiBase` 保持空字符串即可（同源）。

---

## 回滚（线上改坏了怎么办）

**Vercel（最快，30 秒）**

1. 项目 → **Deployments** 标签；
2. 找到上一个「正常」的部署（看时间/提交信息），点它右侧 **⋯ → Promote to Production**；
3. 立刻生效，不需要重新构建。

也可以让 Git 回退后重新部署：

```bash
git revert <坏提交的 hash>
git push
```

**Railway**：项目 → **Deployments** → 选历史部署 → **Redeploy**（或 **Rollback**）。

**只回滚配置不回滚代码**：直接改 `vercel.json`（例如临时去掉 `regions`）后 push，
Vercel 会重新部署；环境变量改动一律记得 **Redeploy**。

---

## 清空数据（换班级 / 开学重置）

线上数据存在 Redis 的 `cube-views:g1` … `cube-views:g8` 这 8 个键里。

**方式 A：用网站接口（最安全，不用碰 Redis）**

```bash
for i in 1 2 3 4 5 6 7 8; do
  curl -s -X POST "https://<你的域名>/api/groups/$i/clear"
  echo
done
```

每个组会返回一个空组对象（`{"group":i,"cubes":[],"updatedAt":...}`）。

**方式 B：Upstash 控制台（最直观）**

Upstash Console → 你的数据库 → **Data Browser** → 逐个选中 `cube-views:g1`…`g8` → **Delete**。

**方式 C：Upstash REST API（命令行）**

```bash
for i in 1 2 3 4 5 6 7 8; do
  curl -s -X POST "$UPSTASH_REDIS_REST_URL" \
    -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
    -H "Content-Type: application/json" \
    -d "[\"DEL\",\"cube-views:g$i\"]"
  echo
done
```

（`$UPSTASH_REDIS_REST_URL` / `$UPSTASH_REDIS_REST_TOKEN` 从 Upstash 控制台 REST API 一栏复制。）

> 本地的 `data/state.json`（`npm start` 用的）是另一份数据，删它不影响线上；
> 反之清空 Redis 也不影响本地。

---

## 常见故障排查

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 打开 `/` 白屏、控制台 404 | Vercel 没识别到静态目录 | 确认 `vercel.json` 里 `outputDirectory` 是 `public`，项目根目录是仓库根；Redeploy |
| `/teacher` 打不开（404） | 重写规则没生效 | `vercel.json` 的 `rewrites` 要有 `/teacher → /teacher.html`；Redeploy |
| 页面能开，但两台设备不同步 | 没配 Redis，或配了没 Redeploy，或用了只读 TOKEN | 看 1.3 / 1.4；Upstash Data Browser 里应出现 `cube-views:g*` |
| `/api/*` 返回 500 | 函数异常 | Vercel → 项目 → **Logs**（Runtime Logs）看 `GET /api/state 失败` 之类的日志；Hobby 只保留 1 小时日志，要尽快看 |
| 学生提交报「保存失败」 | 组号越界 / JSON 太大 / Redis 写失败 | 组号只有 1–8；单次请求 < 512 KB；看日志里有没有 Redis 报错 |
| 日志里 `Redis 不可用（...），已降级为进程内存存储` | Redis 超时（3 秒）/ 额度用完 / URL、TOKEN 配错 | Upstash 控制台看数据库状态与用量；改正环境变量后 Redeploy |
| 国内打不开 `*.vercel.app`，但能打开自定义域名 | `vercel.app` 域名被动/不稳定 | 按 1.7 绑自定义域名 |
| 教师端 2 秒才更新 | Vercel 无 SSE，属预期 | 属正常；想要毫秒级用方案二/三 |
| 首次访问慢 0.5–1 秒 | 函数冷启动 | 上课前先打开一次 `/teacher` 预热 |
| `curl /api/state` 返回 304 | 正常（带了 If-None-Match 且数据没变） | 想要完整数据去掉 `If-None-Match` 头再请求 |

---

## 需要在控制台里人工完成的事（清单）

代码仓库这边已经就绪，下面这些**只能在网页控制台点**，建议按顺序打勾：

- [ ] 把代码推到 GitHub（个人账号下的仓库，不是组织仓库）
- [ ] 在 Vercel **Import** 项目，Framework Preset 选 **Other**，Build Command 留空
- [ ] 在 Vercel **Storage / Marketplace** 创建 Upstash Redis（区域 Singapore，Free），
      并 **Connect** 到本项目
- [ ] 在 **Settings → Environment Variables** 确认 `KV_REST_API_URL` + `KV_REST_API_TOKEN`
      或 `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` 存在，且**不是**只读令牌
- [ ] **Redeploy** 一次，让函数读到环境变量
- [ ] 按 1.5 的 9 条验证一遍（重点：`/api/healthz` 的 `region` 是 `hkg1`、
      Upstash Data Browser 里出现 `cube-views:g*`、两台设备 2–3 秒同步）
- [ ] （强烈建议）绑自定义域名，并在**真实的教室网络**里试一次
- [ ] （可选）Upstash 设 Monthly Budget，防止额度超了被限流