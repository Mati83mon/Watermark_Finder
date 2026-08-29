/**
 * Boots the analysis engine inside the page.
 *
 * The Python in `tpl/` is the same code the server build runs - copied by
 * build.py, never rewritten - so a rule about what counts as a covert channel
 * exists once. Pyodide gives it a CPython to run in; nothing here reimplements
 * any of the analysis.
 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (v) => `${Math.round(v * 100)}%`;

let py = null;

async function boot() {
  try {
    $('boot-text').textContent = 'Downloading the Python runtime…';
    py = await loadPyodide({ indexURL: 'pyodide/' });

    $('boot-text').textContent = 'Loading the analysis modules…';
    const manifest = (await (await fetch('tpl/MANIFEST')).text()).trim().split('\n');
    py.FS.mkdir('/tpl');
    await Promise.all(
      manifest.map(async (name) => {
        const source = await (await fetch(`tpl/${name}`)).text();
        py.FS.writeFile(`/tpl/${name}`, source);
      }),
    );

    py.runPython(`
import sys
sys.path.insert(0, "/")
from tpl.pipeline import analyse
from tpl.marking import mark_for_recipients, MarkingError
from tpl.sanitize import sanitize
import json

def run_analysis(text, mode):
    return json.dumps(analyse(text, mode))

def run_mark(text, recipients, template, channel):
    try:
        copies = mark_for_recipients(text, list(recipients), template=template, channel=channel)
    except MarkingError as exc:
        return json.dumps({"error": str(exc)})
    return json.dumps({"copies": [c.as_dict() for c in copies]})

def run_sanitize(text, level, homoglyphs):
    return json.dumps(sanitize(text, level=level, normalize_homoglyphs=homoglyphs).as_dict())
`);

    $('boot').classList.add('hidden');
    $('app').classList.remove('hidden');
  } catch (error) {
    $('boot').classList.add('hidden');
    $('failed').classList.remove('hidden');
    $('failed-text').textContent =
      `The engine could not start in this browser: ${error.message}. ` +
      'Pyodide needs WebAssembly, which some strict privacy settings block.';
  }
}

/* ---------- tabs ---------- */
document.querySelectorAll('[role=tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    ['analyse', 'protect', 'clean'].forEach((name) => {
      $(`tab-${name}`).classList.toggle('hidden', name !== tab.dataset.tab);
    });
  });
});

/* ---------- analyse ---------- */
$('a-text').addEventListener('input', () => {
  $('a-count').textContent = `${$('a-text').value.length} characters`;
});
$('a-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  $('a-text').value = await file.text();
  $('a-text').dispatchEvent(new Event('input'));
});

$('a-run').addEventListener('click', async () => {
  const text = $('a-text').value;
  if (!text.trim()) return;
  $('a-run').disabled = true;
  $('a-out').innerHTML = '<div class="card"><div class="boot"><span class="spinner"></span>Analysing…</div></div>';
  await new Promise((r) => setTimeout(r, 20));
  try {
    const result = JSON.parse(py.globals.get('run_analysis')(text, 'forensic'));
    $('a-out').innerHTML = renderAnalysis(result);
  } catch (error) {
    $('a-out').innerHTML = `<div class="card"><div class="notice">${esc(error.message)}</div></div>`;
  } finally {
    $('a-run').disabled = false;
  }
});

const BASIS_NOTE = {
  bytes: 'Deterministic: based on the actual bytes of the document.',
  stylistic: 'No hidden characters found. This is a capped stylistic hint, not byte evidence.',
  none: 'Deterministic: no covert channel found in the bytes of the document.',
};

function renderAnalysis(r) {
  const wm = r.scores.watermark;
  const st = r.scores.llm_likelihood;
  const tone = wm.value >= 0.8 ? 'danger' : wm.value >= 0.5 ? 'warn' : 'ok';

  let html = '<div class="card"><div class="score">';
  html += `<div><div class="label">Watermark / covert channel</div>
    <div class="value ${tone}">${pct(wm.value)}</div>
    <div class="label">${esc(wm.label.replace(/_/g, ' '))}</div>
    <p class="muted" style="margin:8px 0 0">${esc(BASIS_NOTE[wm.basis] ?? '')}</p></div>`;
  html += `<div><div class="label">Assistant-register style</div>
    <div class="value">${pct(st.value)}</div>
    <div class="label">${esc(String(st.label).replace(/_/g, ' '))} · confidence ${esc(st.confidence)}</div>
    <p class="muted" style="margin:8px 0 0">Plausible range ${pct(st.low)}–${pct(st.high)}. Register, not authorship.</p></div>`;
  html += '</div>';

  (r.warnings || []).forEach((w) => { html += `<div class="notice">${esc(w)}</div>`; });
  html += '</div>';

  if (r.payloads?.length) {
    html += '<div class="card"><h2 class="danger">Recovered hidden payloads</h2><table><tbody>';
    r.payloads.forEach((p) => {
      html += `<tr><td><code>${esc(p.channel)}</code></td>
        <td><code>${esc(p.text)}</code><div class="muted">${p.carrier_count} carrier character(s), offsets ${p.first_offset}–${p.last_offset}</div></td></tr>`;
    });
    html += '</tbody></table></div>';
  }

  if (r.findings?.length) {
    html += '<div class="card"><h2>Findings</h2><table><tbody>';
    r.findings.forEach((f) => {
      html += `<tr><td><span class="tag">${esc(f.severity)}</span></td>
        <td><strong>${esc(f.title)}</strong><div class="muted">${esc(f.detail)}</div></td></tr>`;
    });
    html += '</tbody></table></div>';
  }

  const contributions = st.contributions || [];
  if (contributions.length) {
    html += '<div class="card"><h2>How the style score was reached</h2><table><thead><tr>'
      + '<th>Feature</th><th>Value</th><th>z</th><th>Towards</th></tr></thead><tbody>';
    contributions.slice(0, 10).forEach((c) => {
      html += `<tr><td><code>${esc(c.feature)}</code></td><td>${Number(c.value).toFixed(3)}</td>
        <td>${c.z >= 0 ? '+' : ''}${Number(c.z).toFixed(2)}</td>
        <td class="${c.direction === 'assistant' ? 'warn' : 'ok'}">${esc(c.direction)}</td></tr>`;
    });
    html += '</tbody></table><p class="muted">Coefficients are a documented prior, not fitted to a labelled corpus.</p></div>';
  }

  html += `<div class="card"><h2>Technical report</h2>
    <pre>${esc(r.technical_report_markdown || '')}</pre></div>`;
  return html;
}

/* ---------- protect ---------- */
$('p-run').addEventListener('click', async () => {
  const text = $('p-text').value;
  const recipients = $('p-recipients').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!text.trim() || !recipients.length) return;
  $('p-run').disabled = true;
  try {
    const out = JSON.parse(
      py.globals.get('run_mark')(text, recipients, $('p-template').value, $('p-channel').value),
    );
    if (out.error) {
      $('p-out').innerHTML = `<div class="card"><div class="notice">${esc(out.error)}</div></div>`;
    } else {
      window.__copies = out.copies;
      let html = '<div class="card"><h2>Marked copies</h2>'
        + '<div class="notice">Save these as .txt, .docx or .md. Exporting to PDF destroys the mark: '
        + 'measured, DOCX preserved 9 of 9 carrier characters and PDF preserved 0 of 9.</div>'
        + '<div class="notice">The mark is not secret. Anyone running this tool on a copy reads the '
        + 'payload, and the Clean tab removes it. This traces honest recipients; it does not defeat '
        + 'someone who knows the technique.</div>'
        + '<table><thead><tr><th>Recipient</th><th>Payload</th><th>Added</th><th>Read back</th><th></th></tr></thead><tbody>';
      out.copies.forEach((c, i) => {
        html += `<tr><td>${esc(c.recipient)}</td><td><code>${esc(c.payload)}</code></td>
          <td class="muted">${c.carrier_chars} chars</td><td class="ok">${c.verified ? '✓' : '—'}</td>
          <td><button class="secondary" onclick="downloadCopy(${i})">Download</button></td></tr>`;
      });
      html += '</tbody></table></div>';
      $('p-out').innerHTML = html;
    }
  } finally {
    $('p-run').disabled = false;
  }
});

window.downloadCopy = (index) => {
  const copy = window.__copies[index];
  const blob = new Blob([copy.text], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${copy.recipient.replace(/[^\w.-]+/g, '_')}.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
};

/* ---------- clean ---------- */
$('c-run').addEventListener('click', async () => {
  const text = $('c-text').value;
  if (!text.trim()) return;
  $('c-run').disabled = true;
  try {
    const level = document.querySelector('input[name=c-level]:checked').value;
    const out = JSON.parse(py.globals.get('run_sanitize')(text, level, $('c-homoglyphs').checked));
    window.__cleaned = out.text;
    let html = '<div class="card"><h2>Result</h2><table><tbody>'
      + `<tr><td>Removed</td><td><strong>${out.removed_total}</strong></td></tr>`
      + `<tr><td>Replaced</td><td><strong>${out.replaced_total}</strong></td></tr>`
      + `<tr><td>Kept on purpose</td><td><strong>${out.preserved_total}</strong></td></tr>`
      + '</tbody></table>';
    (out.warnings || []).forEach((w) => { html += `<div class="notice" style="margin-top:12px">${esc(w)}</div>`; });
    if (!out.changed) html += '<p class="muted">Nothing to remove — this document carries no covert-channel characters.</p>';
    if (out.preserved?.length) {
      html += '<details style="margin-top:10px"><summary class="muted">What was kept, and why</summary><table><tbody>';
      out.preserved.slice(0, 25).forEach((k) => {
        html += `<tr><td><code>${esc(k.codepoint)}</code></td><td class="muted">at ${k.offset} — ${esc(k.reason)}</td></tr>`;
      });
      html += '</tbody></table></details>';
    }
    html += '<div class="row" style="margin-top:14px">'
      + '<button class="secondary" onclick="downloadCleaned()">Download .clean.txt</button>'
      + '<button class="secondary" onclick="navigator.clipboard.writeText(window.__cleaned)">Copy text</button></div></div>';
    $('c-out').innerHTML = html;
  } finally {
    $('c-run').disabled = false;
  }
});

window.downloadCleaned = () => {
  const blob = new Blob([window.__cleaned], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'document.clean.txt';
  link.click();
  URL.revokeObjectURL(link.href);
};

boot();
