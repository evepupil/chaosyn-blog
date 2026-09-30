# 搜索、SEO 与站点完整性

> **模块定位**：管理站内搜索、SEO 元数据、订阅文件、错误页与静态产物完整性
>
> **对应代码**：`features/search/`、`lib/search/`、`lib/seo/`、`app/llms.txt/route.ts`、`lib/deployment/localized-not-found.ts`、`scripts/generate-search-index.ts`、`scripts/prepare-pages-output.ts`、`scripts/check-static-output.ts`
>
> **所属 M 里程碑**：[M5：搜索、SEO 与站点完整性](../roadmap.md#阶段-5搜索seo-与站点完整性)
>
> **当前状态**：已完成
>
> **最近更新时间**：2026-09-30

## 设计

### 职责

本模块负责三件事：把已发布文章生成可在浏览器内检索的轻量索引；为每个静态页面生成正确的公开地址和分享信息；在构建结束后检查 HTML、RSS、站点地图、链接与静态资源是否完整。它不负责在线搜索接口、评论、Notion 同步和生产域名配置。

### 目录结构

| 路径                               | 用途                                        |
| ---------------------------------- | ------------------------------------------- |
| `features/search/`                 | HeroUI 搜索弹窗、文案和样式                 |
| `lib/search/`                      | 分词、索引文档、MiniSearch 配置和浏览器加载 |
| `lib/seo/metadata.ts`              | 页面 canonical、hreflang 和分享元数据       |
| `lib/seo/content-metadata.ts`      | 文章、图书、章节元数据和文章 JSON-LD        |
| `lib/seo/rss.ts`                   | 中英文 RSS 数据与 XML 生成                  |
| `lib/seo/sitemap.ts`               | 静态页面、内容、标签与译文站点地图          |
| `lib/seo/llms.ts`                  | 双语 AI 内容目录生成                        |
| `app/llms.txt/route.ts`            | 构建期静态生成根目录 `llms.txt`             |
| `scripts/generate-search-index.ts` | 构建中英文序列化搜索索引                    |
| `redirects.config.ts`              | 旧路径与旧文章 slug 的集中映射              |
| `lib/redirects/`                   | 映射校验、规则展开和 `_redirects` 序列化    |
| `scripts/generate-redirects.ts`    | 构建 Cloudflare Pages 永久跳转文件          |
| `scripts/check-static-output.ts`   | 检查最终 `out` 目录                         |
| `scripts/prepare-pages-output.ts`  | 生成 Pages 按目录查找的本地化 404 文件      |
| `public/_redirects`                | 从集中配置生成的永久跳转文件                |
| `app/(zh)/rss.xml/route.ts`        | 中文 RSS 静态 Route Handler                 |
| `app/(en)/en/rss.xml/route.ts`     | 英文 RSS 静态 Route Handler                 |
| `app/sitemap.ts`、`app/robots.ts`  | 站点地图和抓取规则                          |

### 关键决策

1. 搜索索引在构建期按语言分别生成。草稿在进入索引前过滤，浏览器不会收到另一种语言的索引。
2. MiniSearch 与索引 JSON 只在首次打开搜索弹窗时并行加载，普通阅读不会下载搜索代码和正文索引。
3. 中文按单个汉字分词，英文按单词分词。查询使用 AND、前缀匹配和长词模糊匹配，减少短查询误命中。
4. 页面元数据统一通过 `lib/seo` 生成。静态栏目自动建立中英文对应关系，文章、图书和章节只在真实译文存在时输出 hreflang。
5. 中文和英文使用两个根布局，构建出的 `<html lang>` 无需等待 hydration。Header 不再在浏览器里补写语言。
6. 文章 JSON-LD 使用 `BlogPosting`，包含作者、发布日期、更新时间、语言、封面和规范地址。序列化时转义 `<`，防止内容结束 script 标签。
7. `pnpm build` 的最后一步解析真实产物。HTML、XML 和 JSON 使用结构化解析器检查，坏链接、缺资源、错误语言或缺少 SEO 字段都会让构建失败。
8. 当前路由继续作为 canonical。旧站路径使用一跳 `301` 合并到对应新页面，不让兼容路径进入 sitemap 或 hreflang。
9. `redirects.config.ts` 是重定向的唯一配置入口。文章换 slug 时删除旧正文、保留新正文，并把旧、新 slug 加入映射；构建会同时生成带尾斜杠和不带尾斜杠的旧地址规则，并把中文路径转成 Cloudflare 实际匹配的百分号编码。
10. Cloudflare Pages 会沿请求目录向上寻找最近的 `404.html`。构建在 `out/en/404.html` 额外保存英文错误页，因此缺失的 `/en/*` 返回英文内容和 404 状态；根目录缺失地址继续使用中文 `out/404.html`。
11. `llms.txt` 在构建期从当前已发布内容生成，列出中英文文章、图书入口和站点索引。草稿不会进入文件，标题、摘要和规范地址沿用内容系统，不维护第二份手写目录。

## 改动历史

### 2026-09-30

- 新增根目录 `llms.txt` 静态路由，为支持该约定的 AI 与代理提供双语文章、图书和站点索引。
- 静态产物检查解析 Markdown 链接，验证文件结构、体积、重复地址和站内目标；部署冒烟检查线上状态、内容类型和双语章节。
- 首版不生成 `llms-full.txt` 或逐页 Markdown 镜像。Cloudflare Markdown for Agents 仍是独立的可选运营配置。

### 2026-07-22

- 构建增加 `out/en/404.html`，让 Cloudflare Pages 为任意缺失的 `/en/*` 地址返回英文 404。
- 静态产物检查验证英文错误页文件，端到端测试验证页面内容，部署后冒烟覆盖真实缺失的英文地址与 404 状态。

### 2026-07-16

- 新增集中式 URL 映射和生成器，把原有固定规则与 18 篇文章的旧 slug 迁移统一生成到 `public/_redirects`。
- 清理 Notion 首次同步产生的 15 份重复正文，旧地址通过单跳 `301` 合并到新 slug，canonical、RSS 和 sitemap 只保留新文章。
- 内容校验确认每个文章重定向目标真实存在、旧 slug 已退出内容目录；静态产物检查覆盖配置中的全部规则，生产冒烟覆盖全部文章迁移。
- 公网冒烟发现 Pages 不匹配原始中文规则后，生成器改为输出百分号编码路径，配置文件继续保留可读中文 slug。
- 图书章节恢复为真实静态路由，章节 canonical、hreflang、sitemap 和站内链接完整性进入构建门禁。
- 删除会把所有旧章节跳到图书首页的通配规则；同 slug 章节直接复用旧 URL，旧日语书名通过保留 `:chapter` 的单跳规则迁移。

### 2026-07-15

- 新增 MiniSearch 构建期索引、HeroUI Modal/SearchField 搜索弹窗和 Header 搜索入口。
- 修复 HeroUI Modal Trigger 内嵌按钮造成的重复可访问控件。
- 将中英文页面迁入独立路由组和根布局，保证静态 HTML 语言正确。
- 为首页、栏目、标签、文章和图书补齐 canonical、hreflang、Open Graph 和 Twitter Card。
- 为文章补充 JSON-LD，并使用文章封面或默认工作区图片作为分享图。
- 生成中英文 RSS、sitemap、robots 和带 `noindex` 的自定义 404；增加显式英文 `/en/404/` 页面。
- 删除图书标签指向不存在文章标签页的死链，图书标签保留为 HeroUI Chip。
- 增加静态产物检查和 SEO 单测，并覆盖搜索、404、关键元数据和无 JavaScript 阅读流程。
- 增加 notion-fuwari 旧文章、归档、标签、关于页、图书章节和 sitemap 的永久重定向，并把规则完整性接入构建检查。

## 实现细节

### 搜索流程

1. `pnpm search:build` 读取全部文章，只保留当前语言的已发布内容。
2. 标题、摘要、标签和正文纯文本写入 MiniSearch，结果只保存标题、摘要、标签、日期与文章路径。
3. 索引序列化到 `public/search-index/{locale}.json`，该目录由构建生成且不提交。
4. 用户首次打开弹窗时，浏览器并行加载 MiniSearch 和当前语言索引。空查询显示最近文章，输入后立即显示匹配数量和结果。
5. 结果使用普通站内链接进入独立文章地址，搜索弹窗关闭后不改变阅读路由规则。

### 元数据与订阅

- `NEXT_PUBLIC_SITE_URL` 是 canonical、分享地址、RSS 和 sitemap 的统一地址来源；本地缺省值为 `http://localhost:3000`。
- 栏目页按相同路由建立中英文 alternates。标签没有跨语言关系，只声明当前语言。
- 文章、图书和章节通过 `translationKey` 找译文，缺少译文时不会输出错误 hreflang。
- RSS 只包含对应语言的已发布文章，按发布时间倒序输出。
- sitemap 包含首页、栏目、文章、图书、图书章节和文章标签；草稿与 404 不进入站点地图。
- `llms.txt` 包含全部已发布中英文文章和图书入口，条目使用绝对规范地址与内容摘要，按站点现有发布顺序输出。

### 构建完整性

`pnpm build` 依次执行内容校验、搜索索引、Next 静态导出和 `pnpm site:check`。产物检查会确认：

- 必需的 RSS、sitemap、robots、`llms.txt`、中英文 404 和搜索索引文件存在；
- 每个正常页面具有正确 `lang`、唯一 canonical、当前语言 hreflang、Open Graph 图片和 Twitter Card；
- 文章页包含可解析的 JSON-LD；404 页包含 `noindex`；
- HTML、RSS 和 sitemap 中的站内地址都能映射到 `out` 中的文件或目录；
- `llms.txt` 具有站点标题与摘要，文件不超过 128 KiB，Markdown 链接无重复且站内目标存在；
- 图片、脚本、样式和站内链接没有缺失目标。

### 旧站 URL 迁移

| 旧路径                                                | 当前路径                                           |
| ----------------------------------------------------- | -------------------------------------------------- |
| `/posts/en/<slug>/`                                   | `/en/posts/<slug>/`                                |
| `/archive/`                                           | `/archives/`                                       |
| `/archive/en/`                                        | `/en/archives/`                                    |
| `/archive/tag/<tag>/`                                 | `/tags/<tag>/`                                     |
| `/archive/en/tag/<tag>/`                              | `/en/tags/<tag>/`                                  |
| `/about/en/`                                          | `/en/about/`                                       |
| `/books/<book>/<chapter>/`                            | 保持原章节地址                                     |
| `/books/《Tae Kim日语语法指南》中文翻译版/<chapter>/` | `/books/tae-kim-japanese-grammar-guide/<chapter>/` |
| `/sitemap-index.xml`                                  | `/sitemap.xml`                                     |

中文文章改用 Notion 当前生成的新 slug。18 个旧 `/posts/<slug>/` 地址集中配置在 `redirects.config.ts`，并永久跳到对应新地址。当前已经上线 `/links/`，旧站友链路径仍待补充精确映射；赞助功能位于文章末尾，没有独立页面可作为旧赞助地址的等价目标。

## 测试方法

- Vitest 覆盖分词、语言隔离、标题/标签/正文命中、RSS 草稿过滤、图书章节 sitemap、译文关系、canonical 和 JSON-LD。
- Vitest 覆盖 `llms.txt` 的双语内容、草稿过滤、图书入口、Markdown 转义和绝对地址。
- Playwright 覆盖中英文搜索、搜索结果导航、关键元数据、中英文 404 页面和关闭 JavaScript 后的阅读路径；`serve` 不模拟 Pages 的目录级错误页查找，真实缺失的英文地址由部署冒烟验证。
- Vitest 覆盖映射展开、重复来源、重定向链和相同源目标校验。
- `pnpm build` 重新生成 `_redirects` 并检查全部配置规则；部署后冒烟验证 18 个旧文章地址返回单跳 `301` 和正确目标。
- 应用内浏览器检查搜索弹窗、结果状态、文章跳转和控制台错误。

## 当前限制

- 搜索索引随站点构建更新，没有在线增量索引。
- canonical、RSS 和 sitemap 已使用 Pages 构建命令传入的 `NEXT_PUBLIC_SITE_URL`；正式域名切换时必须同步修改该值并重新提交 sitemap。
- `llms.txt` 当前链接到规范 HTML 页面，没有生成 `llms-full.txt` 或逐页 Markdown 镜像；Cloudflare Markdown for Agents 尚未启用。
