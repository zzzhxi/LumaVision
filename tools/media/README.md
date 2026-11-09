# 可选媒体工具

Node 网站仍无第三方 JS 依赖，支持 Node 20.11+。图片缩略图和视频 poster 由独立 FFmpeg 子进程处理；默认检测本目录 `ffmpeg.exe`，也可设置 `LUMA_FFMPEG` 为自己的绝对路径。未配置工具时图片沿用原图懒加载，视频使用明确占位，不自动读取视频原件。

本机验证使用 PyPI `imageio-ffmpeg==0.6.0` Windows wheel 附带的 FFmpeg 7.1，仅用于当前本地工具安装；可执行文件 gitignored，不作为源码发行包的一部分。SHA-256：`2CE797A0F88D7F067180338FB227F7B1928EA727BD9A4D7A1D022F7C52AF71A3`。`IMAGEIO-LICENSE` 是 imageio 包许可；FFmpeg 二进制自身采用 GPL v3，分发时需遵守它及所含库的许可，不可用 Python 包许可替代。

来源：[固定版本 Python 包](https://pypi.org/project/imageio-ffmpeg/0.6.0/)、[FFmpeg 文档](https://ffmpeg.org/ffmpeg.html)、[FFmpeg 许可](https://ffmpeg.org/legal.html)。更换工具后可对隔离素材重新验证，再删除可再生的派生缓存；原件不应覆盖。
