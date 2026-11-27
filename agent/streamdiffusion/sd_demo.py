"""SolGPU デモ: StreamDiffusion でリアルタイム画像生成

ノートブックで  `from sd_demo import show; show()`  を実行すると、
プロンプト入力欄と「▶ 生成開始」ボタンが表示されます。

  python sd_demo.py --download   … モデルを先にダウンロード（setup.sh が実行）
  python sd_demo.py --bench      … ノートブック無しで速度だけ測る
"""

from __future__ import annotations

import io
import threading
import time

MODEL = "stabilityai/sd-turbo"  # 1 ステップで描ける軽量モデル
TINY_VAE = "madebyollin/taesd"  # 高速なデコーダ
SIZE = 512
DEFAULT_PROMPT = "a cute cat astronaut floating in space, colorful nebula, highly detailed, digital art"
EXAMPLES = [
    DEFAULT_PROMPT,
    "a futuristic city at night, neon lights, cyberpunk, rain, cinematic",
    "a watercolor painting of mount fuji with cherry blossoms",
    "a cozy wooden cabin in a snowy forest, warm light, oil painting",
    "portrait of a robot samurai, ukiyo-e style",
]


def download() -> None:
    from huggingface_hub import snapshot_download

    for repo in (MODEL, TINY_VAE):
        print("ダウンロード中:", repo, flush=True)
        snapshot_download(repo, allow_patterns=["*.json", "*.txt", "*.fp16.safetensors", "*.model"]
                          if repo == MODEL else None)


class Engine:
    """StreamDiffusion を 1 度だけ読み込み、1 枚ずつ画像を作る"""

    def __init__(self, prompt: str = DEFAULT_PROMPT):
        import warnings

        warnings.filterwarnings("ignore")  # デモ画面に英語の警告を出さない
        import torch
        from diffusers import AutoencoderTiny, StableDiffusionPipeline
        from diffusers.utils import logging as dlog
        from streamdiffusion import StreamDiffusion

        dlog.set_verbosity_error()
        dlog.disable_progress_bar()

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA の GPU が見つかりません（StreamDiffusion は NVIDIA GPU が必要です）")
        self.torch = torch
        self.gpu = torch.cuda.get_device_name(0)
        pipe = StableDiffusionPipeline.from_pretrained(MODEL, torch_dtype=torch.float16, variant="fp16").to("cuda")
        self.stream = StreamDiffusion(
            pipe, t_index_list=[0], torch_dtype=torch.float16, width=SIZE, height=SIZE, cfg_type="none",
        )
        self.stream.vae = AutoencoderTiny.from_pretrained(TINY_VAE).to(device=pipe.device, dtype=pipe.dtype)
        self.prompt = prompt
        self.stream.prepare(prompt, num_inference_steps=50, guidance_scale=0.0)
        for _ in range(3):  # ウォームアップ
            self.stream.txt2img()

    def set_prompt(self, prompt: str) -> None:
        if prompt and prompt != self.prompt:
            self.prompt = prompt
            self.stream.update_prompt(prompt)

    def frame_jpeg(self) -> bytes:
        from streamdiffusion.image_utils import postprocess_image

        with self.torch.no_grad():
            x = self.stream.txt2img()
        img = postprocess_image(x, output_type="pil")[0]
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return buf.getvalue()


_engine: Engine | None = None


def show():
    """プロンプト欄・開始/停止ボタン・画像を表示する"""
    import ipywidgets as w
    from IPython.display import display

    prompt = w.Textarea(value=DEFAULT_PROMPT, description="プロンプト", layout=w.Layout(width="100%", height="64px"))
    examples = w.Dropdown(options=[("例を選ぶ…", "")] + [(e[:60], e) for e in EXAMPLES], value="",
                          layout=w.Layout(width="100%"))
    button = w.Button(description="▶ 生成開始", button_style="success", layout=w.Layout(width="200px", height="44px"))
    status = w.HTML("<b>ボタンを押すと StreamDiffusion が動き出します</b>（初回はモデルの読み込みに 10〜30 秒）")
    image = w.Image(format="jpeg", layout=w.Layout(width=f"{SIZE}px", height=f"{SIZE}px", border="1px solid #ccc"))
    state = {"running": False, "thread": None}

    def on_example(change):
        if change["new"]:
            prompt.value = change["new"]

    examples.observe(on_example, names="value")

    def loop():
        global _engine
        try:
            if _engine is None:
                status.value = "⏳ モデルを GPU に読み込んでいます…"
                _engine = Engine(prompt.value)
            frames, t0 = 0, time.perf_counter()
            while state["running"]:
                _engine.set_prompt(prompt.value.strip())
                image.value = _engine.frame_jpeg()
                frames += 1
                dt = time.perf_counter() - t0
                if dt >= 1:
                    status.value = (f"🟢 生成中 — <b>{frames / dt:.1f} 枚/秒</b>（{_engine.gpu}, {SIZE}×{SIZE}）"
                                    "　プロンプトを書き換えるとすぐ反映されます")
                    frames, t0 = 0, time.perf_counter()
            status.value = "⏸ 停止しました。もう一度押すと再開します"
        except Exception as e:  # noqa: BLE001
            status.value = f"<span style='color:#c00'>エラー: {e}</span>"
        finally:
            state["running"] = False
            button.description, button.button_style = "▶ 生成開始", "success"

    def on_click(_):
        if state["running"]:
            state["running"] = False
            return
        state["running"] = True
        button.description, button.button_style = "■ 停止", "danger"
        state["thread"] = threading.Thread(target=loop, daemon=True)
        state["thread"].start()

    button.on_click(on_click)
    display(w.VBox([prompt, examples, w.HBox([button]), status, image]))


if __name__ == "__main__":
    import sys

    if "--download" in sys.argv:
        download()
    if "--bench" in sys.argv:
        t = time.perf_counter()
        e = Engine()
        print(f"読み込み {time.perf_counter() - t:.1f} 秒 ({e.gpu})")
        t, n = time.perf_counter(), 30
        for _ in range(n):
            e.frame_jpeg()
        print(f"{n / (time.perf_counter() - t):.1f} 枚/秒")
        e.set_prompt(EXAMPLES[1])
        open("sample.jpg", "wb").write(e.frame_jpeg())
        print("sample.jpg を保存しました")
