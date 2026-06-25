# 可选：安装 Go

当前第一版使用 Node.js 标准库实现，已经可以验证双端转发。安装 Go 不是运行当前版本的必要条件。

如果后续要做成更轻的单文件可执行程序，例如 Windows `.exe` 和 macOS 可执行文件，可以安装 Go 后再迁移实现。

## macOS

如果已经安装 Homebrew：

```bash
brew update
brew install go
go version
```

也可以使用 Go 官方 `.pkg` 安装包：

```text
https://go.dev/dl/
```

官方安装说明：

```text
https://go.dev/doc/install
```

## Windows

最稳妥的方式是打开官方下载页，下载 Windows MSI 安装包：

```text
https://go.dev/dl/
```

安装完成后，关闭并重新打开 PowerShell，然后验证：

```powershell
go version
```

## 说明

Go 官方安装文档要求安装后用 `go version` 验证是否成功。Windows MSI 安装后通常需要重新打开命令行窗口，环境变量才会生效。
