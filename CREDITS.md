# 出处与致谢

本仓的每块能力都标清楚：用了谁的、用到什么程度。

---

## 一、直接使用的

| 项目 | 我们用它做了什么 | 链接 |
|---|---|---|
| **dsh-napcat** | 生产环境的通道层（OneBot 11）。本仓的沉默拦截就加在它的发送入口上 | <https://github.com/wzwei1990/dsh-napcat> |
| **FeiyuVoice-CosyVoice3** | **只取了它的参考音频**（两段）做音色复刻。**未运行它的模型、未使用它的推理代码** | [HuggingFace](https://huggingface.co/Esmerubphire/FeiyuVoice-CosyVoice3) · [ModelScope](https://modelscope.cn/models/Esmerubphire/FeiyuVoice-CosyVoice3) |
| **FeiyuVoice-RVC** | 下载过、分析过结构。云端 CPU 环境装完了依赖但未进入生产链路 | [ModelScope](https://modelscope.cn/models/Esmerubphire/FeiyuVoice-RVC) |
| **MiniMax T2A** | 生产环境的语音合成 + 音色复刻 | <https://platform.minimaxi.com> |
| **DeepSeek** | 模型（实测 `deepseek-flash` 原生支持图像输入） | <https://api-docs.deepseek.com> |
| **pilk** | silk 编解码尝试（**最终未采用**，见 [实测记录](docs/05-实测记录.md) 第 4 条） | <https://github.com/foyoux/pilk> |

## 二、看过但未采用

| 项目 | 为什么看它 | 为什么不用 |
|---|---|---|
| **astrbot_plugin_feiyu_voice** | 看它怎么组织 TTS / RVC / 唱歌三条链路 | 需要本地 GPU；本仓目标是无 GPU 环境可跑 |
| **whale-voice** | 看它的 IndexTTS2 情感预设、软糯标尺、自动调参思路 | 同上。它的「软糯标尺」思路很好，但本仓暂未实现等价物 |
| **GPT-SoVITS / CosyVoice2** | 作为本地声库方案评估 | 需要 GPU，与「走云端」的前提冲突 |

> “未采用”不等于 “不好”。是取舍，不是评价。

## 三、许可提醒

- **dsh-napcat**：MIT
- **FeiyuVoice-CosyVoice3**：上游 CosyVoice 为 Apache-2.0；该声仓自己明确写了“未对本仓整体指派许可证，角色身份与合成参考音频的来源未完全确定”。**所以本仓不附带任何参考音频**，只说明这个方法
- **MiniMax / DeepSeek**：商业 API，按各自条款使用

如果要用别人的声库做商用，先去核对那个声库自己的许可说明。

## 四、本仓自己写的

- 文档（docs/、PLAN.md）与人格模板（persona/）
- 状态层/沉默的实现思路与代码（packages/）
- 实测记录里的所有结论

## 五、报错方式

发现本仓用了谁的东西没标清楚、或标错了 —— 直接开 issue。这类错误比代码 bug 更严重。
