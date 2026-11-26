from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "minecraft-agent-progress-20261122.pdf"
FONT = Path("C:/Windows/Fonts/msyh.ttc")
FONT_BOLD = Path("C:/Windows/Fonts/msyhbd.ttc")

pdfmetrics.registerFont(TTFont("YaHei", str(FONT), subfontIndex=0))
pdfmetrics.registerFont(TTFont("YaHei-Bold", str(FONT_BOLD), subfontIndex=0))

INK = colors.HexColor("#1D2B36")
BLUE = colors.HexColor("#167D91")
PALE = colors.HexColor("#EAF3F4")
LINE = colors.HexColor("#D5E0E3")
MUTED = colors.HexColor("#5B6B73")
WARN = colors.HexColor("#A34B32")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="Cover", fontName="YaHei-Bold", fontSize=24, leading=32, textColor=INK, alignment=TA_LEFT, spaceAfter=7 * mm))
styles.add(ParagraphStyle(name="Sub", fontName="YaHei", fontSize=10, leading=16, textColor=MUTED, spaceAfter=5 * mm))
styles.add(ParagraphStyle(name="H1cn", fontName="YaHei-Bold", fontSize=15, leading=21, textColor=INK, spaceBefore=5 * mm, spaceAfter=3 * mm, keepWithNext=True))
styles.add(ParagraphStyle(name="H2cn", fontName="YaHei-Bold", fontSize=10.5, leading=15, textColor=BLUE, spaceBefore=3 * mm, spaceAfter=1.5 * mm, keepWithNext=True))
styles.add(ParagraphStyle(name="Bodycn", fontName="YaHei", fontSize=9, leading=14, textColor=INK, spaceAfter=2 * mm))
styles.add(ParagraphStyle(name="Smallcn", fontName="YaHei", fontSize=7.5, leading=11, textColor=MUTED))
styles.add(ParagraphStyle(name="Cellcn", fontName="YaHei", fontSize=8, leading=11, textColor=INK))
styles.add(ParagraphStyle(name="CellHeadcn", fontName="YaHei-Bold", fontSize=8, leading=11, textColor=colors.white))
styles.add(ParagraphStyle(name="Callout", fontName="YaHei-Bold", fontSize=10, leading=15, textColor=BLUE, backColor=PALE, borderPadding=8, spaceBefore=2 * mm, spaceAfter=3 * mm))


def p(text, style="Bodycn"):
    return Paragraph(text, styles[style])


def table(rows, widths, header=True):
    cooked = []
    for i, row in enumerate(rows):
        cooked.append([p(str(value), "CellHeadcn" if header and i == 0 else "Cellcn") for value in row])
    item = Table(cooked, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    commands = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
    ]
    if header:
        commands.append(("BACKGROUND", (0, 0), (-1, 0), BLUE))
        for row_idx in range(1, len(rows)):
            if row_idx % 2 == 0:
                commands.append(("BACKGROUND", (0, row_idx), (-1, row_idx), PALE))
    item.setStyle(TableStyle(commands))
    return item


def footer(canvas, doc):
    canvas.saveState()
    width, _ = A4
    canvas.setStrokeColor(LINE)
    canvas.line(18 * mm, 15 * mm, width - 18 * mm, 15 * mm)
    canvas.setFont("YaHei", 7)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 10 * mm, "Minecraft AI Agent | 项目进展与发行包说明 | 2026-11-22")
    canvas.drawRightString(width - 18 * mm, 10 * mm, str(doc.page))
    canvas.restoreState()


def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(OUTPUT), pagesize=A4,
        rightMargin=18 * mm, leftMargin=18 * mm,
        topMargin=18 * mm, bottomMargin=21 * mm,
        title="Minecraft AI Agent 项目进展",
        author="AIA-MC Engineering",
    )
    story = [
        Spacer(1, 10 * mm),
        p("Minecraft AI Agent", "Cover"),
        p("工程进度、实机结果与分发包说明 | 截至 2026 年 11 月 22 日", "Sub"),
        p("当前结论", "H1cn"),
        p("项目已具备可分发的单 Bot 运行包：JavaScript 运行时、C++ 自动化核心、调试 UI、多 Bot 隔离管理与空凭据模板。核心游戏里程碑已在 2026/11/15 的六小时窗口实机完成全套钻石甲；后续本地九小时回归继续验证任务恢复和 Tac，但没有完成全部目标。", "Callout"),
        table([
            ["领域", "已确认结果", "状态"],
            ["游戏进度", "六小时收尾时四个装备栏均为钻石甲；背包2颗散钻、1把钻石镐。", "实机确认"],
            ["自动化", "采集、采矿、合成、战斗/生存响应由 C++ 长任务执行，LLM 负责策略、分发和异常修复决策。", "已部署"],
            ["多 Bot", "共享代码与原生核心；API连接、队列、记忆、路线、账本和运行状态分 bot 隔离。", "管理器与并发测试"],
            ["附魔/建筑", "附魔台、书架附魔和漂亮小家未取得完成证据；附魔按可选分支处理。", "未完成/待验证"],
        ], [29 * mm, 105 * mm, 38 * mm]),
        p("运行架构", "H1cn"),
        p("Strategy 负责阶段目标，Distribution 生成完整工作，NativeExecutor 逐 bot 串行执行，C++ 核心负责长时间采集、挖掘、导航、合成、建造与恢复。不同 bot 不共享 skill 队列，因此相同 skill 可以并行；同一 bot 内的动作保持顺序。", "Bodycn"),
        p("时间管理按运行窗口和目标时限规划任务，不新增到点强制自动停机。运行状态与各自预算应分别查看；服务器端对账号或请求并发的限制仍可能造成排队。", "Bodycn"),
        PageBreak(),
        p("工程进展", "H1cn"),
        table([
            ["时间 / 主题", "结果与证据边界"],
            ["2026/11/15 六小时主线", "实机确认钻石头盔、胸甲、护腿、靴子均已穿戴，1把钻石镐与2颗散钻；未进入下界。地狱门与房屋美化未完成。"],
            ["挖矿与恢复", "固定鱼骨矿道可保存主道/支道位置并续跑；矿物按价值和距离处理，遇洞探索可达裸露矿后回到原检查点。若干复杂落差恢复仅有模拟覆盖，尚非完整实机验证。"],
            ["合成与设施", "本地配方 DAG 先核对原料；工作台/熔炉/箱子交互、附魔台复用和可选附魔流程已有修复与测试。附魔完成结果尚未确认。"],
            ["九小时本地回归", "全新 1.21.11 世界中早期工具、资源采集、脚本恢复与 Tac 对照持续运行。主 bot 曾卡在无可达树木，Tac 对照 bot 曾进入低血并死亡；回归窗口最终结束。"],
            ["多 Bot 与连续移动", "多 bot 相同 skill 并发/状态路径隔离已有定向测试。连续中距移动回归减少段间多余 `/status` 请求。"],
            ["异常续接", "已登记的新续接任务优先于旧 warning 退避，避免有效恢复任务被过期失败阻塞；专项回归通过。"],
            ["时间与预算", "六小时报告里的在线采样 running 比例为70.1%，仅为采样代理值；不等于精确脚本时长。会话累计 Token 不是该窗口净增量，不能据此宣称达到整体预算目标。"],
        ], [42 * mm, 130 * mm]),
        p("未解决事项", "H1cn"),
        p("1. 九小时回归里，bot 在资源目标附近长期报告无可达树木，任务没有形成有效前进。<br/>2. 历史日志仍有重复 `missing_item`、导航超时和不安全路径 warning；虽已增加退避与恢复，仍需在新窗口观察。<br/>3. Tac 低血/死亡对照出现真实事件，救援策略与默认行为仍需以新的安全实机测试确认。<br/>4. 附魔台/书架流程、附魔结果、地狱门与房屋建造成果都不能根据模块或模拟测试推定完成。", "Bodycn"),
        p("验证范围", "H1cn"),
        p("关键定向测试通过，历史全量测试曾因对话与矿物暂存用例失败、鱼骨夹具超时而未完成；本次发行包不宣称全套测试通过。2026/11/22 查询本地面板时 status 返回 online，但 worker PID 为空，没有活动 Worker 的证据；位置/背包信息不代表当前正在执行任务。", "Bodycn"),
        PageBreak(),
        p("分发与配置", "H1cn"),
        p("发行包含一个已编译的 Windows C++ 核心、Node.js 源码、UI、测试、构建脚本、启动脚本和无凭据配置模板。接收方需安装 Node.js 24+；重新编译时需 C++17 g++。不包含运行数据目录、游戏世界、会话记忆、Token 日志、服务器存档或本机加密凭据。", "Bodycn"),
        table([
            ["配置项", "发行包默认值 / 操作"],
            ["游戏 API", "https://mc-api.windywindie.top/api/v1；账号与密码由接收方本机填写。"],
            ["模型服务", "https://api.nju-aia.com/v1；模型名称与 API Key 留空，由接收方配置。"],
            ["皮肤站", "账号与密码不写入任何发行文件、PDF 或日志；需要时由接收方在本机单独设置。"],
            ["多 Bot", "bots.example.json 展示每个实例独立设置 name、URL、账号和数据目录的格式。"],
            ["时间预算", "按每个 Bot 的运行目标/剩余时间安排工作；不在发行管理器里增加到点强制关机逻辑。"],
        ], [38 * mm, 134 * mm]),
        p("凭据处理", "H1cn"),
        p("对话中出现的 LLM Key 与皮肤站密码没有写进包或报告。分享前请轮换这些值，并在目标机器本地重新录入。发行包模板只保留公开服务地址，秘密字段为空。", "Bodycn"),
        p("数据来源", "H1cn"),
        p("本报告依据项目文件：docs/six-hour-report-20261115.md、docs/local-nine-hour-report-20261116.md、docs/overnight-debug.md、docs/native-architecture.md 与 docs/multi-bot.md；另对 2026/11/22 本地调试接口做了只读状态查询。历史进度与当前在线状态分别陈述。", "Smallcn"),
        Spacer(1, 3 * mm),
        p("交付边界：此包便于复制到另一台 Windows 机器运行；API 服务访问、账号授权、模型供应商并发限制与真实世界行为仍由运行环境决定。", "Smallcn"),
    ]
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(OUTPUT)


if __name__ == "__main__":
    build()
