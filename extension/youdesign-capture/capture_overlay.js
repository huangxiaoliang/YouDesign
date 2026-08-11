(() => {
  const HOST_ID = "__yd_capture_overlay";
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    existing.dispatchEvent(new CustomEvent("yd-capture-overlay-show"));
    return;
  }

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("data-yd-capture-extension-ui", "true");
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("top", "12px", "important");
  host.style.setProperty("right", "12px", "important");
  host.style.setProperty("z-index", "2147483647", "important");
  host.style.setProperty("display", "block", "important");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      *{box-sizing:border-box}
      .card{width:248px;border:1px solid #d9d9d9;border-radius:8px;background:#fff;color:#1f2937;box-shadow:0 6px 20px rgba(0,0,0,.16);font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
      .head{height:34px;display:flex;align-items:center;padding:0 7px 0 10px;background:#f8fafc;cursor:move;user-select:none}
      .title{font-weight:600;flex:1}.icon{width:24px;height:24px;padding:0;border:0;border-radius:4px;background:transparent;color:#64748b;cursor:pointer}.icon:hover{background:#e8edf5}
      .body{padding:8px}.collapsed .body{display:none}.collapsed.card{width:138px}
      .note{margin-bottom:7px;color:#52c41a}.list{display:grid;gap:5px;max-height:210px;overflow:auto}
      .row{min-height:30px;display:flex;align-items:center;gap:7px;padding:5px 7px;border:1px solid #e5e7eb;border-radius:5px;background:#fff}.row .label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.state{margin-left:auto;white-space:nowrap}.pending{color:#fa8c16}.captured{color:#52c41a}
      .actions{display:flex;gap:6px;margin-top:8px}.btn{height:28px;padding:0 9px;border:0;border-radius:5px;background:#1677ff;color:#fff;font:inherit;cursor:pointer}.btn.secondary{background:#eef4ff;color:#165dba}.btn.danger{background:#fff1f0;color:#cf1322}.btn:disabled{opacity:.45;cursor:not-allowed}
      .status{min-height:17px;margin-top:6px;color:#6b7280}.error{color:#cf1322}.success{color:#52c41a}.hidden{display:none!important}
    </style>
    <section class="card">
      <header class="head">
        <span class="title">页签采集</span>
        <button class="icon minimize" type="button" title="收起">—</button>
        <button class="icon close" type="button" title="隐藏">×</button>
      </header>
      <div class="body">
        <div class="note hidden"></div>
        <div class="list"></div>
        <div class="actions selector-actions hidden"><button class="btn start" type="button">开始</button><button class="btn danger dismiss" type="button">取消</button></div>
        <div class="actions progress-actions hidden"><button class="btn capture" type="button">采集当前</button><button class="btn secondary finish" type="button">合并发送</button><button class="btn danger cancel" type="button">取消</button></div>
        <div class="status"></div>
      </div>
    </section>`;

  const card = shadow.querySelector(".card");
  const list = shadow.querySelector(".list");
  const note = shadow.querySelector(".note");
  const status = shadow.querySelector(".status");
  const selectorActions = shadow.querySelector(".selector-actions");
  const progressActions = shadow.querySelector(".progress-actions");
  let catalog = null;

  const setStatus = (message, error = false, success = false) => {
    status.textContent = message || "";
    status.classList.toggle("error", error);
    status.classList.toggle("success", success);
  };
  const send = async (action, extra = {}) => {
    const response = await chrome.runtime.sendMessage({
      source: "youdesign-capture-popup",
      action,
      ...extra,
    });
    if (!response?.ok) throw new Error(response?.error || "操作失败");
    return response;
  };
  const row = (labelText, stateText = "", stateClass = "") => {
    const item = document.createElement("div");
    item.className = "row";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = labelText;
    item.append(label);
    if (stateText) {
      const state = document.createElement("span");
      state.className = `state ${stateClass}`;
      state.textContent = stateText;
      item.append(state);
    }
    return item;
  };
  const renderSelector = () => {
    const defaults = catalog.tabs.filter((tab) => tab.defaultCaptured);
    const pending = catalog.tabs.filter((tab) => !tab.defaultCaptured);
    note.textContent = defaults.length ? `已打开 ${defaults.length} 个，自动采集` : "";
    note.classList.toggle("hidden", !defaults.length);
    list.replaceChildren(...pending.map((tab) => {
      const item = row(tab.label, "待采集", "pending");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "guided-tab";
      checkbox.value = tab.key;
      checkbox.checked = true;
      item.prepend(checkbox);
      return item;
    }));
    shadow.querySelector(".start").disabled = !defaults.length && !pending.length;
    selectorActions.classList.remove("hidden");
    progressActions.classList.add("hidden");
  };
  const renderProgress = (session) => {
    const targets = session.tabs.filter((tab) => !tab.defaultCaptured && tab.selected);
    note.textContent = session.defaultCapturedCount ? `默认已采集 ${session.defaultCapturedCount} 个` : "";
    note.classList.toggle("hidden", !session.defaultCapturedCount);
    list.replaceChildren(...targets.map((tab) => row(tab.label, tab.status === "captured" ? "已采集" : "待采集", tab.status === "captured" ? "captured" : "pending")));
    selectorActions.classList.add("hidden");
    progressActions.classList.remove("hidden");
    shadow.querySelector(".finish").disabled = session.capturedCount === 0 && session.defaultCapturedCount === 0;
    setStatus(`已采集 ${session.capturedCount}/${session.selectedCount}`, false, true);
  };
  const inspect = async () => {
    setStatus("正在识别…");
    const response = await send("inspect-tabs");
    catalog = response.catalog;
    renderSelector();
    setStatus("");
  };
  const initialize = async () => {
    try {
      const response = await send("guided-status");
      renderProgress(response.session);
    } catch {
      try {
        await inspect();
      } catch (error) {
        setStatus(error.message, true);
      }
    }
  };

  shadow.querySelector(".start").addEventListener("click", async () => {
    try {
      const selectedKeys = Array.from(shadow.querySelectorAll('input[name="guided-tab"]:checked')).map((input) => input.value);
      setStatus("正在建立基线…");
      const response = await send("start-guided", { selectedKeys });
      renderProgress(response.session);
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  shadow.querySelector(".capture").addEventListener("click", async () => {
    try {
      setStatus("正在采集当前页签…");
      const response = await send("capture-guided-tab");
      renderProgress(response.session);
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  shadow.querySelector(".finish").addEventListener("click", async () => {
    try {
      setStatus("正在合并…");
      await send("finish-guided");
      host.remove();
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  shadow.querySelector(".cancel").addEventListener("click", async () => {
    try {
      await send("cancel-guided");
      host.remove();
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  shadow.querySelector(".dismiss").addEventListener("click", () => host.remove());
  shadow.querySelector(".close").addEventListener("click", () => {
    host.style.setProperty("display", "none", "important");
  });
  shadow.querySelector(".minimize").addEventListener("click", () => {
    card.classList.toggle("collapsed");
  });
  host.addEventListener("yd-capture-overlay-show", () => {
    host.style.setProperty("display", "block", "important");
    card.classList.remove("collapsed");
    void initialize();
  });

  const header = shadow.querySelector(".head");
  let drag = null;
  header.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    const rect = host.getBoundingClientRect();
    drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    header.setPointerCapture(event.pointerId);
  });
  header.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const left = Math.max(4, Math.min(window.innerWidth - host.offsetWidth - 4, event.clientX - drag.x));
    const top = Math.max(4, Math.min(window.innerHeight - 38, event.clientY - drag.y));
    host.style.setProperty("left", `${left}px`, "important");
    host.style.setProperty("top", `${top}px`, "important");
    host.style.removeProperty("right");
  });
  header.addEventListener("pointerup", () => {
    drag = null;
  });

  (document.body || document.documentElement).append(host);
  void initialize();
})();
