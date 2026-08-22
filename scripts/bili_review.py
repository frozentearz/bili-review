#!/usr/bin/env python3
"""
bili-review - B站视频字幕抓取 + 评论区爬取
子功能:
  subtitle  <bvid|url>           抓取AI字幕(yt-dlp, 自动复用本地登录态)
  comments  <bvid|url> --limit   爬取评论区(公开API, 免登录, 按点赞排序)
  all       <bvid|url>           字幕+评论一起输出
  login                          从浏览器提取登录态存本地(首次需授权一次, 有效约150天)
  status                          查看登录态状态

登录态方案: 首次执行自动从浏览器提取 cookie 存 cookies.txt, 之后150天内自动复用;
          过期后自动重新提取。多浏览器自动探测(chrome/edge/firefox/brave等)。
纯 Python 标准库, 无第三方 API Key。
"""
import argparse
import concurrent.futures
import http.cookiejar
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

BVID_PATTERN = re.compile(r'BV[0-9A-Za-z]{10}')
AID_PATTERN = re.compile(r'(?:av|AV)(\d+)')

BASE_DIR = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = Path(__file__).resolve().parent
COOKIE_FILE = BASE_DIR / "cookies.txt"

BROWSERS = ["chrome", "edge", "firefox", "brave", "chromium",
            "opera", "vivaldi", "whale", "safari"]


def extract_bvid(text: str) -> str:
    """从 BV号 / AV号 / 完整链接 / b23.tv 短链中提取 BV 号."""
    text = str(text).strip()
    m = BVID_PATTERN.search(text)
    if m:
        return m.group(0)

    # 支持 AV 号 (如 av170001, AV2)
    m_aid = AID_PATTERN.search(text)
    if m_aid:
        aid = m_aid.group(1)
        try:
            data = http_get_json(f"https://api.bilibili.com/x/web-interface/view?aid={aid}")
            if data.get('code') == 0 and data.get('data', {}).get('bvid'):
                return data['data']['bvid']
        except Exception:
            pass

    if 'b23.tv' in text:
        url = text if text.startswith(('http://', 'https://')) else f"https://{text}"
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                final_url = resp.geturl()
            m = BVID_PATTERN.search(final_url)
            if m:
                return m.group(0)
        except Exception:
            pass
    raise ValueError(f"无法从输入中解析BV号: {text}")


def http_get_json(url: str, referer: str = None, retries: int = 3) -> dict:
    """带 412 限流退避重试的 JSON 请求."""
    headers = {'User-Agent': UA}
    if referer:
        headers['Referer'] = referer
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 412 and attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            raise RuntimeError(f"B站限流(HTTP {e.code}), 请稍后重试") from e
        except urllib.error.URLError as e:
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"网络请求失败: {e.reason}") from e


def get_video_info(bvid: str) -> dict:
    """通过 view 接口获取 aid 和元信息."""
    data = http_get_json(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}",
                         referer=f"https://www.bilibili.com/video/{bvid}")
    if data.get('code') != 0:
        raise RuntimeError(f"获取视频信息失败: {data.get('message')}")
    d = data['data']
    return {
        'aid': d['aid'],
        'title': d['title'],
        'author': d['owner']['name'],
        'stats': {
            'view': d['stat']['view'],
            'like': d['stat']['like'],
            'comment': d['stat']['reply'],
        },
    }


# ---------- 登录态管理 ----------

def find_ytdlp_python() -> str:
    """定位安装了 yt_dlp 模块的 python 环境(用于解密浏览器 cookie)."""
    # 1. 当前环境若直接支持 yt_dlp 模块，直接复用
    try:
        import yt_dlp  # noqa: F401
        return sys.executable
    except ImportError:
        pass

    # 2. 检查 which yt-dlp 的 shebang 解释器
    ytdlp_bin = shutil.which('yt-dlp')
    if ytdlp_bin and os.path.exists(ytdlp_bin):
        try:
            with open(ytdlp_bin, 'rb') as f:
                first_line = f.readline().decode('utf-8', errors='ignore').strip()
                if first_line.startswith('#!') and 'python' in first_line:
                    py_path = first_line[2:].strip()
                    if os.path.exists(py_path):
                        return py_path
        except Exception:
            pass

    # 3. macOS Homebrew 常见路径探测
    candidates = []
    try:
        prefix = subprocess.run(['brew', '--prefix', 'yt-dlp'], capture_output=True,
                                text=True, timeout=5)
        if prefix.returncode == 0:
            candidates.append(str(Path(prefix.stdout.strip()) / "libexec" / "bin" / "python3"))
    except Exception:
        pass
    candidates.append('/opt/homebrew/opt/yt-dlp/libexec/bin/python3')
    candidates.append('/usr/local/opt/yt-dlp/libexec/bin/python3')
    for c in candidates:
        if c and os.path.exists(c):
            return c
    return sys.executable


def extract_cookies_from_browser(browser: str, output: Path) -> bool:
    """用 yt-dlp 的 python 调用 extract_cookies.py 从指定浏览器提取 cookie.
    仅提取 B站 相关域名, 不导出其他网站; 保存为 600 权限."""
    try:
        cmd = [find_ytdlp_python(), str(SCRIPTS_DIR / "extract_cookies.py"), browser, str(output)]
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=60)
        if output.exists() and output.stat().st_size > 0:
            os.chmod(output, 0o600)
            return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False
    return False


def validate_login(cookie_file: Path) -> bool:
    """通过 nav 接口校验 cookie 是否有效(需包含有效 SESSDATA)."""
    if not cookie_file.exists():
        return False
    cj = http.cookiejar.MozillaCookieJar(str(cookie_file))
    try:
        cj.load(ignore_discard=True, ignore_expires=True)
    except Exception:
        return False
    if 'SESSDATA' not in {c.name: c.value for c in cj}:
        return False
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    try:
        req = urllib.request.Request("https://api.bilibili.com/x/web-interface/nav",
                                     headers={'User-Agent': UA, 'Referer': 'https://www.bilibili.com/'})
        with opener.open(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        return data.get('data', {}).get('isLogin', False)
    except Exception:
        return False


def get_cookie_file() -> Path:
    """获取有效 cookie 文件; 无则自动从浏览器提取(首次需授权一次)."""
    if COOKIE_FILE.exists() and validate_login(COOKIE_FILE):
        return COOKIE_FILE

    print("未检测到有效登录态, 正在从浏览器提取 cookie ...", file=sys.stderr)
    for browser in BROWSERS:
        tmp = Path(tempfile.mkdtemp()) / "cookies.txt"
        if extract_cookies_from_browser(browser, tmp) and validate_login(tmp):
            os.chmod(tmp, 0o600)
            tmp.replace(COOKIE_FILE)
            print(f"已从 {browser} 提取登录态 -> {COOKIE_FILE}", file=sys.stderr)
            return COOKIE_FILE
    raise RuntimeError(
        "浏览器 cookie 提取失败(弹窗被取消或无B站登录)。"
        f"请确认浏览器已登录B站后重试: python3 {SCRIPTS_DIR / 'bili_review.py'} login")


def get_login_uname(cookie_file: Path) -> str:
    cj = http.cookiejar.MozillaCookieJar(str(cookie_file))
    cj.load(ignore_discard=True, ignore_expires=True)
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    req = urllib.request.Request("https://api.bilibili.com/x/web-interface/nav",
                                 headers={'User-Agent': UA})
    data = json.loads(opener.open(req, timeout=15).read().decode())
    return data.get('data', {}).get('uname', '')


def cmd_login(args) -> None:
    """显式提取浏览器 cookie 到本地文件."""
    if COOKIE_FILE.exists() and validate_login(COOKIE_FILE):
        print(f"登录态已存在且有效: {COOKIE_FILE}")
        print(f"当前账号: {get_login_uname(COOKIE_FILE)} (有效期约150天)")
        return
    print("将从浏览器提取B站登录态; 系统弹窗弹出时请授权(仅需一次, 之后150天内自动复用)")
    get_cookie_file()
    print(f"登录成功: {get_login_uname(COOKIE_FILE)} (有效期约150天)")


def cmd_status(args) -> None:
    """查看登录态状态."""
    if COOKIE_FILE.exists() and validate_login(COOKIE_FILE):
        print(f"登录态有效: {COOKIE_FILE}")
        print(f"当前账号: {get_login_uname(COOKIE_FILE)}")
    elif COOKIE_FILE.exists():
        print(f"登录态已过期: {COOKIE_FILE} (运行 login 重新提取)")
    else:
        print(f"未找到登录态文件: {COOKIE_FILE} (运行 login 提取)")


# ---------- 评论区 ----------

# 楼层爬取公式: 楼层 = min(200, ceil(评论数×30% ÷ 20) × 20)
# 数学性质: 单调不降, 20条/页对齐, 自动封顶200楼(10页)
def floor_limit(total: int) -> int:
    return min(200, math.ceil(total * 0.3 / 20) * 20)


# 楼中楼单楼规则: 按某楼评论的楼中楼数量决定爬取条数(对齐到20条/页)
def reply_limit(count: int) -> int:
    if count <= 20:
        return count
    elif count <= 250:
        return 40  # 2页
    else:
        return 60  # 3页


def fetch_replies(aid: int, rpid: int, max_replies: int = 60) -> list:
    """抓取某条评论的深度楼中楼回复: 按 pn 翻页直到收集满 max_replies 条或数据结束.
    基于 rpid 集合防死循环, 过滤过短无意义水评."""
    collected = []
    seen_rpids = set()
    pn = 1
    while len(collected) < max_replies:
        try:
            data = http_get_json(
                f"https://api.bilibili.com/x/v2/reply/reply?type=1&oid={aid}"
                f"&root={rpid}&ps=20&pn={pn}",
                referer="https://www.bilibili.com/")
        except Exception:
            break
        if data.get('code') != 0:
            break
        replies = (data.get('data') or {}).get('replies') or []
        if not replies:
            break
        page_rpids = {r['rpid'] for r in replies}
        if page_rpids.issubset(seen_rpids):
            break
        for r in replies:
            if r['rpid'] in seen_rpids:
                continue
            seen_rpids.add(r['rpid'])
            text = r.get('content', {}).get('message', '').strip()
            if len(text) <= 1:
                continue
            collected.append({
                'like': r.get('like', 0),
                'author': r.get('member', {}).get('uname', '匿名'),
                'text': text,
            })
            if len(collected) >= max_replies:
                break
        cursor = (data.get('data') or {}).get('page') or {}
        if cursor.get('count', 0) <= pn * 20:
            break
        pn += 1
    return collected


def estimate_crawl(total: int, include_replies: bool = False) -> tuple:
    """预估全量抓取的请求次数和耗时."""
    main_pages = math.ceil(total / 20)
    if include_replies:
        # 预估约 25% 的楼层有深度回复需要深挖，平均每个 1.5 页
        reply_reqs = int(main_pages * 20 * 0.25 * 1.5)
        est_reqs = main_pages + reply_reqs
        sec = max(2, int(est_reqs / 10))
    else:
        est_reqs = main_pages
        sec = max(1, int(est_reqs / 5))

    if sec < 60:
        time_str = f"约 {sec} 秒"
    else:
        mins = sec // 60
        time_str = f"约 {mins} 分 {sec % 60} 秒"
    return est_reqs, time_str


def confirm_full_crawl(total: int, include_replies: bool, yes: bool) -> bool:
    """针对大评论量全量抓取进行时间预估与二次确认. 返回 True 表示确认全量，False 表示降级为默认限制."""
    if total <= 500 or yes:
        return True
    est_reqs, time_str = estimate_crawl(total, include_replies)
    prompt_msg = (
        f"\n[提示] 视频总评论数: {fmt_num(total)} 条。\n"
        f"全量扫描预计需要 {est_reqs} 次请求，耗时 {time_str}（高频请求可能触发 B 站限流）。\n"
        f"是否继续全量抓取？[y/N]: "
    )
    if not sys.stdin.isatty():
        print(f"[提示] 视频总评论数: {fmt_num(total)} 条。全量预计耗时 {time_str}。(非交互环境未指定 -y，自动使用默认安全上限)", file=sys.stderr)
        return False
    try:
        res = input(prompt_msg).strip().lower()
        if res in ('y', 'yes'):
            return True
        print("已取消全量抓取，自动使用默认安全上限（最多 200 楼）继续执行。\n", file=sys.stderr)
        return False
    except (KeyboardInterrupt, EOFError):
        print("\n已取消全量抓取，自动使用默认安全上限（最多 200 楼）继续执行。\n", file=sys.stderr)
        return False


def fetch_comments(bvid: str, limit: int = 200, include_replies: bool = False, is_full: bool = False) -> dict:
    """爬取评论区: 免登录公开API, 热门排序(mode=3).
    楼层规则: limit=0 或 is_full=True 为全量抓取，否则 min(200, 评论数×30%对齐20/页).
    轻量去噪: 过滤过短字符, 同一文本出现超过3次则跳过(不中断主流程).
    死循环防护: 基于 rpid 集合与 cursor 状态判断.
    楼中楼: 默认利用接口自带预览; 开启 include_replies 时多线程并发深挖."""
    info = get_video_info(bvid)
    total = info['stats']['comment']
    target = float('inf') if (is_full or limit == 0) else min(floor_limit(total), limit)
    comments = []
    seen_rpids = set()
    text_freq = {}
    next_page = 0

    try:
        while len(comments) < target:
            data = http_get_json(
                f"https://api.bilibili.com/x/v2/reply/main?type=1&oid={info['aid']}"
                f"&mode=3&next={next_page}",
                referer=f"https://www.bilibili.com/video/{bvid}")
            if data.get('code') != 0:
                raise RuntimeError(f"获取评论失败: {data.get('message')}")
            d = data.get('data') or {}
            replies = d.get('replies') or []
            if not replies:
                break
            page_rpids = {r['rpid'] for r in replies}
            if page_rpids.issubset(seen_rpids):
                break
            for r in replies:
                rpid = r['rpid']
                if rpid in seen_rpids:
                    continue
                seen_rpids.add(rpid)
                text = r.get('content', {}).get('message', '').strip()
                if len(text) <= 1:
                    continue
                text_freq[text] = text_freq.get(text, 0) + 1
                if text_freq[text] > 3:
                    continue  # 同文本刷屏超过3次仅跳过当前条, 绝不中断后续爬取
                c = {
                    'rpid': rpid,
                    'like': r.get('like', 0),
                    'author': r.get('member', {}).get('uname', '匿名'),
                    'text': text,
                    'rcount': r.get('rcount', 0),
                    'replies': [],
                }
                # 白嫖主接口自带的 1~3 条热评回复
                for er in (r.get('replies') or []):
                    er_text = er.get('content', {}).get('message', '').strip()
                    if len(er_text) > 1:
                        c['replies'].append({
                            'like': er.get('like', 0),
                            'author': er.get('member', {}).get('uname', '匿名'),
                            'text': er_text,
                        })
                comments.append(c)
                if len(comments) >= target:
                    break
            cursor = d.get('cursor') or {}
            next_page = cursor.get('next', next_page + 1)
            if cursor.get('is_end') or next_page is None:
                break

        # 开启 --replies 时，对回复数多于已解析条数的楼层进行线程池并发深挖
        if include_replies:
            needs_deep = [c for c in comments if c['rcount'] > len(c['replies'])]
            if needs_deep:
                def enrich(comment):
                    max_r = reply_limit(comment['rcount'])
                    deep = fetch_replies(info['aid'], comment['rpid'], max_replies=max_r)
                    if deep:
                        comment['replies'] = deep

                with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                    list(executor.map(enrich, needs_deep))

    except KeyboardInterrupt:
        print(f"\n[已中断] 正在整理并输出当前已抓取的 {len(comments)} 条评论...", file=sys.stderr)

    return {'info': info, 'total': total, 'comments': comments}


def fmt_num(n) -> str:
    n = int(n or 0)
    if n >= 10000:
        return f"{n / 10000:.1f}万"
    return str(n)


def print_comments_list(result: dict, include_meta: bool = True) -> None:
    info = result['info']
    if include_meta:
        print(f"# 视频: {info['title']}")
        print(f"# BVID: {info.get('bvid', '')}")
        print(f"# UP主: {info['author']}")
        s = info['stats']
        print(f"# 播放: {fmt_num(s['view'])} / 点赞: {fmt_num(s['like'])} / 评论: {fmt_num(s['comment'])}")
        print(f"# 评论总数(接口返回): {fmt_num(result['total'])}")
        print()
    print(f"## 热门评论 TOP {len(result['comments'])}")
    for i, c in enumerate(result['comments'], 1):
        print(f"{i}. [点赞 {fmt_num(c['like'])}] {c['author']}: {c['text']}")
        for j, r in enumerate(c.get('replies', []), 1):
            print(f"   └ 楼中楼{j}. [点赞 {fmt_num(r['like'])}] {r['author']}: {r['text']}")


# ---------- 字幕 ----------

def fetch_subtitle(bvid: str, lang: str = None) -> str:
    """yt-dlp 抓取字幕. AI字幕(ai-*)需要登录态, 自动复用本地 cookie 文件."""
    language = lang or 'ai-zh'
    cookie_file = None
    try:
        cookie_file = get_cookie_file()
    except RuntimeError as e:
        if language.startswith("ai-"):
            raise RuntimeError(f"{e}\nAI字幕需要登录态, 无法自动获取。")
        print(f"警告: {e}", file=sys.stderr)

    with tempfile.TemporaryDirectory() as temp_dir:
        cmd = ["yt-dlp", "--write-subs", "--write-auto-subs", "--skip-download",
               "--sub-lang", language, "--output", "subs", "--no-playlist"]
        if cookie_file:
            cmd.extend(["--cookies", str(cookie_file)])
        cmd.extend([
            "--add-header", f"User-Agent: {UA}",
            "--add-header", "Referer: https://www.bilibili.com/",
            f"https://www.bilibili.com/video/{bvid}",
        ])
        try:
            subprocess.run(cmd, cwd=temp_dir, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as e:
            err = (e.stderr or "").lower()
            if "412" in err or "rate" in err:
                raise RuntimeError("yt-dlp 被B站限流(HTTP 412), 稍后重试。")
            if "logged in" in err or "subtitles" in err:
                raise RuntimeError(f"该视频没有 {language} 字幕。可尝试 --lang ai-en 等。")
            raise RuntimeError(f"yt-dlp 执行失败: {e.stderr}")
        except FileNotFoundError:
            raise RuntimeError("未找到 yt-dlp, 请先安装: brew install yt-dlp")

        files = list(Path(temp_dir).glob("*.vtt")) + list(Path(temp_dir).glob("*.srt"))
        if not files:
            raise RuntimeError(f"未找到字幕文件, 该视频可能没有 {language} 字幕。")

        content = files[0].read_text(encoding='utf-8', errors='replace')
        return clean_subtitle(content, files[0].suffix.lower())


def clean_subtitle(content: str, suffix: str) -> str:
    lines = content.splitlines()
    out = []
    ts = re.compile(r'\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?')
    for line in lines:
        line = line.strip()
        if not line or line == 'WEBVTT' or line.isdigit() or line.startswith(('NOTE', 'STYLE', 'Kind:', 'Language:')):
            continue
        if ts.match(line):
            continue
        line = re.sub(r'<[^>]+>', '', line)
        # 仅做相邻重复行滑动去重，保留后续视频中正常重复出现的台词
        if not line or (out and out[-1] == line):
            continue
        out.append(line)
    return '\n'.join(out)


def print_subtitle_output(bvid: str, lang: str) -> None:
    info = get_video_info(bvid)
    text = fetch_subtitle(bvid, lang)
    s = info['stats']
    print(f"# 视频: {info['title']}")
    print(f"# BVID: {bvid}")
    print(f"# UP主: {info['author']}")
    print(f"# 播放: {fmt_num(s['view'])} / 点赞: {fmt_num(s['like'])} / 评论: {fmt_num(s['comment'])}")
    print(f"# 字幕语言: {lang or 'ai-zh'}")
    print()
    print(text)


# ---------- 入口 ----------

def main():
    parser = argparse.ArgumentParser(description="bili-review: B站字幕+评论抓取")
    sub = parser.add_subparsers(dest="mode", required=True)

    p_login = sub.add_parser("login", help="从浏览器提取登录态存本地(首次授权一次)")
    p_login.set_defaults(func=cmd_login)

    p_status = sub.add_parser("status", help="查看登录态状态")
    p_status.set_defaults(func=cmd_status)

    for name in ("subtitle", "comments", "all"):
        p = sub.add_parser(name, help=f"{name} 抓取")
        p.add_argument("input", help="BV号 / 视频链接 / b23.tv 短链")
        p.add_argument("--lang", default=None, help="字幕语言(默认 ai-zh, 如 en 用 ai-en)")
        p.add_argument("--limit", type=int, default=200, help="楼层目标上限(默认200, 设为0或使用--all-comments表示全量抓取)")
        p.add_argument("--all-comments", action="store_true", help="全量爬取评论区(不设上限)")
        p.add_argument("-y", "--yes", action="store_true", help="自动确认全量抓取，跳过交互提示")
        p.add_argument("--replies", action="store_true", help="同时抓取楼中楼(按楼数规则对齐20条/页: 20内全爬, 250内取40, 250+取60)")
        p.set_defaults(func=None)
    args = parser.parse_args()

    if args.func:
        try:
            args.func(args)
        except Exception as e:
            print(f"错误: {e}", file=sys.stderr)
            sys.exit(1)
        return

    try:
        if args.limit < 0:
            raise ValueError(f"--limit 不能为负数(当前 {args.limit})")
        bvid = extract_bvid(args.input)
        want_full = getattr(args, 'all_comments', False) or args.limit == 0
        is_full = False
        limit = args.limit
        if want_full:
            info = get_video_info(bvid)
            is_full = confirm_full_crawl(info['stats']['comment'], getattr(args, 'replies', False), getattr(args, 'yes', False))
            if not is_full:
                limit = 200

        if args.mode == 'subtitle':
            print_subtitle_output(bvid, args.lang)
        elif args.mode == 'comments':
            result = fetch_comments(bvid, limit, args.replies, is_full=is_full)
            result['info']['bvid'] = bvid
            print_comments_list(result, include_meta=True)
        else:
            info = get_video_info(bvid)
            info['bvid'] = bvid
            subtitle_text = fetch_subtitle(bvid, args.lang)
            result = fetch_comments(bvid, limit, args.replies, is_full=is_full)
            s = info['stats']
            print(f"# 视频: {info['title']}")
            print(f"# BVID: {bvid}")
            print(f"# UP主: {info['author']}")
            print(f"# 播放: {fmt_num(s['view'])} / 点赞: {fmt_num(s['like'])} / 评论: {fmt_num(s['comment'])}")
            print()
            print("## 字幕")
            print()
            print(subtitle_text)
            print()
            print("## 评论区")
            print()
            print_comments_list(result, include_meta=False)
    except Exception as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
