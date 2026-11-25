"""SolGPU エージェントの部品: Solana 上の SolGPU プログラムとのやり取り

- アカウントのデコードと命令のエンコードは、ビルド時に生成された IDL (sorana_market.json) に従う
- エージェントの鍵 (operator) で署名できるのは accept / settle / update_agent だけ。
  代金の行き先はプログラム側で固定されているので、この鍵が漏れてもお金は盗まれない
"""

from __future__ import annotations

import base64
import json
import struct
import time
import urllib.error
import urllib.request
from pathlib import Path

from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.transaction import Transaction

IDL = json.loads((Path(__file__).resolve().parent / "sorana_market.json").read_text(encoding="utf-8"))
PROGRAM_ID = Pubkey.from_string(IDL["address"])
_TYPES = {t["name"]: t["type"] for t in IDL["types"]}
_ACCOUNT_DISC = {a["name"]: bytes(a["discriminator"]) for a in IDL["accounts"]}
_IX = {i["name"]: i for i in IDL["instructions"]}


# ---------------------------------------------------------------- Borsh (IDL に書かれた型だけ対応)
def _decode(t, buf: bytes, o: int):
    if t == "pubkey":
        return str(Pubkey.from_bytes(buf[o : o + 32])), o + 32
    if t == "bool":
        return buf[o] != 0, o + 1
    if t in ("u8", "u32", "u64", "i64"):
        fmt = {"u8": "<B", "u32": "<I", "u64": "<Q", "i64": "<q"}[t]
        return struct.unpack_from(fmt, buf, o)[0], o + struct.calcsize(fmt)
    if t == "string":
        (n,) = struct.unpack_from("<I", buf, o)
        return buf[o + 4 : o + 4 + n].decode("utf-8"), o + 4 + n
    if isinstance(t, dict) and "array" in t:
        inner, n = t["array"]
        assert inner == "u8"
        return bytes(buf[o : o + n]), o + n
    if isinstance(t, dict) and "defined" in t:
        d = _TYPES[t["defined"]["name"]]
        if d["kind"] == "enum":
            return d["variants"][buf[o]]["name"], o + 1
        return _decode_struct(d, buf, o)
    raise ValueError(f"unsupported type {t}")


def _decode_struct(d, buf: bytes, o: int):
    out = {}
    for f in d["fields"]:
        out[f["name"]], o = _decode(f["type"], buf, o)
    return out, o


def _encode(t, v) -> bytes:
    if t == "pubkey":
        return bytes(Pubkey.from_string(v) if isinstance(v, str) else v)
    if t == "bool":
        return b"\x01" if v else b"\x00"
    if t in ("u8", "u32", "u64", "i64"):
        return struct.pack({"u8": "<B", "u32": "<I", "u64": "<Q", "i64": "<q"}[t], v)
    if t == "string":
        b = v.encode("utf-8")
        return struct.pack("<I", len(b)) + b
    raise ValueError(f"unsupported type {t}")


def decode_account(name: str, data: bytes) -> dict:
    if data[:8] != _ACCOUNT_DISC[name]:
        raise ValueError(f"not a {name} account")
    out, _ = _decode_struct(_TYPES[name], data, 8)
    return out


def build_ix(name: str, accounts: dict[str, Pubkey | str], args: dict | None = None) -> Instruction:
    spec = _IX[name]
    data = bytes(spec["discriminator"]) + b"".join(_encode(a["type"], (args or {})[a["name"]]) for a in spec["args"])
    metas = []
    for a in spec["accounts"]:
        key = accounts[a["name"]]
        key = Pubkey.from_string(key) if isinstance(key, str) else key
        metas.append(AccountMeta(key, is_signer=bool(a.get("signer")), is_writable=bool(a.get("writable"))))
    return Instruction(PROGRAM_ID, data, metas)


# ---------------------------------------------------------------- RPC
class Chain:
    def __init__(self, rpc_url: str):
        self.rpc_url = rpc_url

    def rpc(self, method: str, params: list, retries: int = 5):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        delay = 1.0
        for attempt in range(retries):
            req = urllib.request.Request(self.rpc_url, data=body, headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = json.loads(r.read())
                if "error" in data:
                    err = data["error"]
                    logs = (err.get("data") or {}).get("logs") or []
                    raise RuntimeError(err.get("message", str(err)) + ("\n" + "\n".join(logs[-6:]) if logs else ""))
                return data["result"]
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < retries - 1:
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise
            except urllib.error.URLError:
                if attempt < retries - 1:
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise
        raise RuntimeError("RPC retry exhausted")

    def account(self, name: str, address: str) -> dict | None:
        res = self.rpc("getAccountInfo", [address, {"encoding": "base64", "commitment": "confirmed"}])
        v = res["value"]
        if not v or v["owner"] != str(PROGRAM_ID):
            return None
        return decode_account(name, base64.b64decode(v["data"][0]))

    def balance(self, address: str) -> int:
        return self.rpc("getBalance", [address, {"commitment": "confirmed"}])["value"]

    def chain_time(self) -> int:
        slot = self.rpc("getSlot", [{"commitment": "confirmed"}])
        t = self.rpc("getBlockTime", [slot])
        return int(t) if t else int(time.time())

    def send(self, signer: Keypair, ixs: list[Instruction], timeout: float = 60) -> str:
        """署名して送信し、confirmed になるまで待つ。失敗時はプログラムのログ付きで例外"""
        bh = self.rpc("getLatestBlockhash", [{"commitment": "confirmed"}])["value"]["blockhash"]
        msg = Message.new_with_blockhash(ixs, signer.pubkey(), Hash.from_string(bh))
        tx = Transaction([signer], msg, Hash.from_string(bh))
        sig = self.rpc(
            "sendTransaction",
            [base64.b64encode(bytes(tx)).decode(), {"encoding": "base64", "preflightCommitment": "confirmed"}],
        )
        deadline = time.time() + timeout
        while time.time() < deadline:
            st = self.rpc("getSignatureStatuses", [[sig]])["value"][0]
            if st:
                if st.get("err"):
                    raise RuntimeError(f"transaction failed: {st['err']}")
                if st.get("confirmationStatus") in ("confirmed", "finalized"):
                    return sig
            time.sleep(1)
        raise TimeoutError(f"transaction not confirmed: {sig}")


def load_or_create_operator(path: Path) -> Keypair:
    """エージェントの鍵。初回起動時に作成し、data/operator.json に保存する"""
    if path.exists():
        return Keypair.from_bytes(bytes(json.loads(path.read_text())))
    kp = Keypair()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(list(bytes(kp))))
    return kp
