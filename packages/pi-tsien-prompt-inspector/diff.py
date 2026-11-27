#!/usr/bin/env python3
"""对比相邻两次 provider payload，定位每轮缓存失效 / 隐藏注入。

用法:
  python3 diff.py                     # 对比 prompt-inspector history/ 里最新两份
  python3 diff.py A.json B.json       # 对比指定两份快照
  python3 diff.py --trace             # 从最新的 pitrace events-*.jsonl 取最后两次请求
  python3 diff.py --trace FILE.jsonl  # 指定 trace 文件
  python3 diff.py --trace --around 5  # 取 trace 里第 4、5 次请求(1 起)

回答三个问题:
  1. system / tools 是否逐轮变化(会导致全量缓存失效)
  2. 消息序列的公共前缀有多长, 第一条不同的消息是什么(失效点)
  3. 每轮真正新增的字符量, 以及 reasoning 等非文本字段占多少
"""
import json
import os
import sys
import glob

STORE = os.path.expanduser("~/.pi/agent/prompt-inspector/history")
TRACE_CANDIDATES = [
    os.environ.get("PI_TRACE_DIR", ""),
    "/run/media/user/DISK/pi-traces",
    os.path.expanduser("~/.pi/agent/pi-traces"),
]


def load(path):
    with open(path) as f:
        return json.load(f)


def msg_text(m):
    c = m.get("content")
    if isinstance(c, str):
        n = len(c)
    elif isinstance(c, list):
        n = sum(len(b.get("text", "") or "") for b in c if isinstance(b, dict))
    else:
        n = 0
    # Responses API: function_call.arguments / function_call_output.output 也是正文
    for k in ("arguments", "output"):
        v = m.get(k)
        if isinstance(v, str):
            n += len(v)
    return n


def hidden_chars(m):
    """reasoning / 加密块等不计入正文的字段大小。"""
    out = {}
    for k, v in m.items():
        if k in ("role", "content", "tool_call_id", "name", "arguments", "output", "type", "id", "call_id", "status"):
            continue
        s = len(json.dumps(v, ensure_ascii=False))
        if s > 2:
            out[k] = s
    return out


def compare(a, b, name_a, name_b):
    pa, pb = a["payload"], b["payload"]
    print(f"A = {name_a}  model={a.get('model')}")
    print(f"B = {name_b}  model={b.get('model')}")
    print(f"间隔 {(b['capturedAt']-a['capturedAt'])/1000:.1f}s")

    # Chat Completions 用 messages；Responses API（openai-codex）用 input + instructions
    ma = pa.get("messages") or pa.get("input") or []
    mb = pb.get("messages") or pb.get("input") or []
    for key in ("system", "instructions"):
        if key in pa or key in pb:
            print(f"{key}: {'一致' if pa.get(key)==pb.get(key) else '*** 变化 ***'}")
    sys_a = next((m for m in ma if m.get("role") == "system"), None)
    sys_b = next((m for m in mb if m.get("role") == "system"), None)
    if sys_a is not None or sys_b is not None:
        print(f"system 消息: {'一致' if sys_a == sys_b else '*** 变化 ***'} "
              f"({msg_text(sys_a or {})} -> {msg_text(sys_b or {})} 字符)")
    ta, tb = pa.get("tools", []), pb.get("tools", [])
    print(f"tools: {'一致' if ta == tb else '*** 变化 ***'} "
          f"({len(json.dumps(ta))} -> {len(json.dumps(tb))} 字符, {len(ta)} -> {len(tb)} 个)")
    for key in ("reasoning_effort", "enable_thinking", "max_tokens", "store", "previous_response_id"):
        if pa.get(key) != pb.get(key):
            print(f"参数 {key}: {pa.get(key)} -> {pb.get(key)}")

    n = 0
    for x, y in zip(ma, mb):
        if x != y:
            break
        n += 1
    print(f"\n消息数 {len(ma)} -> {len(mb)}; 完全相同的前缀 {n} 条")
    if n < len(ma):
        for i in range(max(0, n - 1), min(len(ma), n + 2)):
            x, y = ma[i], (mb[i] if i < len(mb) else None)
            print(f"  首个不同消息[{i}] role={x.get('role') or x.get('type')} "
                  f"正文 {msg_text(x)} -> {msg_text(y or {})} 字符; "
                  f"整体 {len(json.dumps(x))} -> {len(json.dumps(y)) if y else 0} 字符")
            if y is not None:
                hx, hy = hidden_chars(x), hidden_chars(y)
                if hx or hy:
                    print(f"    隐藏字段 A={hx} B={hy}")
    else:
        print("  历史消息完全一致(没有改写), 只有末尾新增")

    new = mb[len(ma):]
    print(f"\n末尾新增 {len(new)} 条:")
    for m in new[-6:]:
        print(f"  role={str(m.get('role') or m.get('type')):10s} 正文 {msg_text(m):7d} 字符  "
              f"整体 {len(json.dumps(m)):7d} 字符  隐藏字段 {hidden_chars(m)}")

    total_a = sum(len(json.dumps(m, ensure_ascii=False)) for m in ma)
    total_b = sum(len(json.dumps(m, ensure_ascii=False)) for m in mb)
    prefix_chars = sum(len(json.dumps(m, ensure_ascii=False)) for m in ma[:n])
    print(f"\n字符估算: A 全部消息 {total_a}, B {total_b}, 完全相同前缀 {prefix_chars}")
    print(f"  => B 中需要重新发送(未命中缓存)的部分约 {total_b - prefix_chars} 字符, "
          f"其中真正新增 {sum(len(json.dumps(m, ensure_ascii=False)) for m in new)}")
    for name, payload in (("A", pa), ("B", pb)):
        hidden = {}
        for m in (payload.get("messages") or payload.get("input") or []):
            for k, v in hidden_chars(m).items():
                hidden[k] = hidden.get(k, 0) + v
        if hidden:
            print(f"  {name} 隐藏字段合计: {hidden}")


def latest_trace_file():
    for root in TRACE_CANDIDATES:
        if not root or not os.path.isdir(root):
            continue
        files = glob.glob(os.path.join(root, "sessions", "*", "events-*.jsonl"))
        if files:
            return max(files, key=os.path.getmtime)
    return None


def from_trace(path, around=None):
    reqs = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("event") == "provider_request" and d.get("payload"):
                reqs.append(d)
    if len(reqs) < 2:
        print(f"{path} 里只有 {len(reqs)} 次 provider_request，再跑几轮")
        sys.exit(1)
    idx = (around - 1) if around else len(reqs) - 2
    idx = max(0, min(idx, len(reqs) - 2))
    out = []
    for k in (idx, idx + 1):
        d = reqs[k]
        m = d.get("model")
        out.append(({
            "capturedAt": d.get("timestampMs", 0),
            "model": f"{m.get('provider')}/{m.get('id')}" if isinstance(m, dict) else m,
            "payload": d["payload"],
        }, f"{os.path.basename(path)}#req{k+1}"))
    print(f"trace 共 {len(reqs)} 次请求，对比第 {idx+1} 与第 {idx+2} 次")
    return out[0], out[1]


def main():
    args = sys.argv[1:]
    if args and args[0] == "--trace":
        rest = args[1:]
        around = None
        if "--around" in rest:
            i = rest.index("--around")
            around = int(rest[i + 1])
            rest = rest[:i] + rest[i + 2:]
        path = rest[0] if rest else latest_trace_file()
        if not path:
            print("没找到 trace 文件；先确认 recorder 已启用并跑过对话")
            return
        print(f"trace 文件: {path}")
        (a, na), (b, nb) = from_trace(path, around)
        compare(a, b, na, nb)
        return
    if len(args) == 2:
        a, b = load(args[0]), load(args[1])
        compare(a, b, os.path.basename(args[0]), os.path.basename(args[1]))
        return
    files = sorted(glob.glob(os.path.join(STORE, "*.json")))
    if len(files) < 2:
        print(f"快照不足两份: {STORE}（或用 --trace 读 pitrace）")
        return
    a, b = load(files[-2]), load(files[-1])
    compare(a, b, os.path.basename(files[-2]), os.path.basename(files[-1]))


if __name__ == "__main__":
    main()
