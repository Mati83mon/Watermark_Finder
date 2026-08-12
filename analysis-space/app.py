"""Hugging Face Space entry point.

The Space runs ``uvicorn app:app`` (see the Dockerfile). A Gradio panel can be
mounted at ``/ui`` for manual testing by setting ``TPL_ENABLE_GRADIO=1``; it is
off by default so the container stays small and boots quickly on the free CPU
tier.
"""

from __future__ import annotations

import json
import logging

from tpl.api import create_app
from tpl.config import VERSION, get_settings
from tpl.perplexity import warmup
from tpl.pipeline import analyse

logger = logging.getLogger("tpl.app")

app = create_app()
settings = get_settings()


@app.on_event("startup")
async def _startup() -> None:
    logger.info("text-provenance-lab %s starting", VERSION)
    if settings.enable_perplexity:
        logger.info("Perplexity backend requested; warming up")
        if warmup():
            logger.info("Perplexity backend ready")
        else:
            logger.warning("Perplexity backend unavailable, continuing without it")


def _mount_gradio() -> None:
    """Attach a small manual-testing UI at /ui when Gradio is installed."""
    try:
        import gradio as gr
    except ImportError:
        logger.warning("TPL_ENABLE_GRADIO=1 but gradio is not installed; skipping /ui")
        return

    def run(text: str, mode: str):
        if not text.strip():
            return "Paste some text first.", "{}"
        result = analyse(text, mode)  # type: ignore[arg-type]
        summary = (
            f"Watermark: {result['scores']['watermark']['value']:.2f} "
            f"({result['scores']['watermark']['label']})\n"
            f"Assistant-register style: {result['scores']['llm_likelihood']['value']:.2f} "
            f"({result['scores']['llm_likelihood']['label']})\n"
            f"Risk: {result['scores']['risk']['value']:.2f} ({result['scores']['risk']['label']})"
        )
        return summary, json.dumps(result, ensure_ascii=False, indent=2)

    with gr.Blocks(title="text-provenance-lab") as blocks:
        gr.Markdown(
            "## text-provenance-lab\n"
            "Manual testing panel. The production client is the Cloudflare Worker "
            "calling `POST /analyze`."
        )
        text_input = gr.Textbox(lines=14, label="Text")
        mode_input = gr.Radio(["quick", "forensic"], value="forensic", label="Mode")
        summary_output = gr.Textbox(label="Summary", lines=4)
        json_output = gr.Code(label="Full result", language="json")
        gr.Button("Analyse", variant="primary").click(
            run, [text_input, mode_input], [summary_output, json_output]
        )

    gr.mount_gradio_app(app, blocks, path="/ui")
    logger.info("Gradio UI mounted at /ui")


if settings.enable_gradio:
    _mount_gradio()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
