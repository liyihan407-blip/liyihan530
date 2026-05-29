# 情侣网页

这是一个甜一点的情侣网页：

- 公开首页任何人都能看
- 管理员登录后才能上传照片、写日志、修改内容
- 图片和日志会保存到持久目录

## 本地运行

```powershell
npm start
```

打开：

- 首页：`http://localhost:3000`
- 管理页：`http://localhost:3000/admin`

默认管理员密码：

```text
love2026
```

你也可以自己改：

```powershell
$env:ADMIN_PASSWORD="你的新密码"
npm start
```

## 部署到 Render

这个项目已经准备好了 Render Blueprint，根目录里有 `render.yaml`。

部署思路是：

1. 把代码推到 GitHub
2. 在 Render 新建 Web Service，连接这个仓库
3. 按 `render.yaml` 创建服务
4. 在环境变量里设置 `ADMIN_PASSWORD`
5. 让服务挂载持久盘，这样上传的照片和日志不会丢

## 需要买域名吗

不需要。

你可以先直接用 Render 给你的默认地址访问，等以后想要更好记的名字，再单独绑定自定义域名。

## 现在这版支持什么

- 首页公开访问
- 照片墙
- 恋爱日志
- 管理员登录
- 新增、编辑、删除日志
- 图片上传
- 持久化保存

## 存储位置

默认本地开发时，数据会放在：

- `data/site.json`
- `uploads/`

部署到 Render 时，会改用 `render.yaml` 里配置的持久目录。
