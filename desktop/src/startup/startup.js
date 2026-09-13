/**
 * Startup Window 渲染逻辑（renderer，仅经 preload 白名单 IPC 通信）。
 *
 * 无 preload（如纯浏览器预览）时降级为静态「等待主进程连接」展示。
 */
"use strict";

(function () {
  const api = window.stayops;
  const PHASES = ["env", "ports", "database", "migration", "backend", "frontend"];
  const STEP_LABELS = {
    env: "检查运行环境",
    ports: "检查端口",
    database: "连接数据库",
    migration: "检查数据库版本",
    backend: "启动后端",
    frontend: "启动前端",
  };

  const views = {
    starting: document.getElementById("view-starting"),
    migration: document.getElementById("view-migration"),
    admin: document.getElementById("view-admin"),
    error: document.getElementById("view-error"),
    ready: document.getElementById("view-ready"),
  };
  // 管理员凭据视图的背景视图（点击「我已记录」后恢复）
  let adminReturnView = "starting";
  const subtitle = document.getElementById("subtitle");
  const stepNote = document.getElementById("step-note");
  const steps = {};
  for (const phase of PHASES) {
    steps[phase] = document.querySelector(`li[data-phase="${phase}"]`);
  }

  function showView(name) {
    for (const key of Object.keys(views)) {
      views[key].hidden = key !== name;
    }
  }

  function setStep(phase, status, detail) {
    const li = steps[phase];
    if (!li) return;
    li.dataset.status = status;
    const label = li.querySelector(".step-label");
    if (label && detail) {
      label.textContent = `${STEP_LABELS[phase]} · ${detail}`;
    } else if (label) {
      label.textContent = STEP_LABELS[phase];
    }
  }

  function resetSteps() {
    for (const phase of PHASES) {
      setStep(phase, "pending");
    }
  }

  function onEvent(event) {
    if (!event || typeof event !== "object") return;
    switch (event.type) {
      case "phase": {
        if (event.status === "loading") {
          resetSteps();
          for (const phase of PHASES) {
            if (phase === event.phase) {
              setStep(phase, "loading", event.detail);
            } else if (PHASES.indexOf(phase) < PHASES.indexOf(event.phase)) {
              setStep(phase, "ok");
            }
          }
          subtitle.textContent = `正在${STEP_LABELS[event.phase] || "启动"}`;
          stepNote.textContent = event.detail || `正在${STEP_LABELS[event.phase] || "启动"}…`;
        } else if (event.status === "ok") {
          setStep(event.phase, "ok", event.detail);
          stepNote.textContent = `✓ ${STEP_LABELS[event.phase] || ""}完成`;
          subtitle.textContent = "正在启动";
        } else if (event.status === "error") {
          setStep(event.phase, "error", event.detail);
        }
        break;
      }
      case "migration-behind": {
        document.getElementById("mig-current").textContent = event.current;
        document.getElementById("mig-head").textContent = event.head;
        subtitle.textContent = "需要升级数据库";
        showView("migration");
        break;
      }
      case "admin-bootstrap": {
        // 首次安装：管理员初始密码只在此处显示一次（绝不写日志/持久化）
        adminReturnView = views.ready.hidden ? "starting" : "ready";
        document.getElementById("admin-username").textContent = event.username || "admin";
        document.getElementById("admin-password").textContent = event.password || "";
        subtitle.textContent = "首次启动：请记录管理员初始密码";
        showView("admin");
        break;
      }
      case "error": {
        subtitle.textContent = "启动失败";
        document.getElementById("error-message").textContent = event.message || "未知错误";
        const detail = document.getElementById("error-detail");
        if (event.detail) {
          detail.textContent = event.detail;
          detail.hidden = false;
        } else {
          detail.hidden = true;
        }
        showView("error");
        break;
      }
      case "ready": {
        subtitle.textContent = "就绪";
        showView("ready");
        break;
      }
      default:
        break;
    }
  }

  // ---------- 按钮 ----------
  document.getElementById("btn-upgrade").addEventListener("click", () => {
    if (api) api.migrationUpgrade();
  });
  document.getElementById("btn-quit").addEventListener("click", () => {
    if (api) api.quit();
  });
  document.getElementById("btn-retry").addEventListener("click", () => {
    if (api) api.retry();
  });
  document.getElementById("btn-logs").addEventListener("click", () => {
    if (api) api.openLogs();
  });
  document.getElementById("btn-admin-ack").addEventListener("click", () => {
    // 用户已记录：清除显示内容并恢复背景视图（不再提供二次查看）
    document.getElementById("admin-password").textContent = "—";
    showView(adminReturnView);
  });
  document.getElementById("btn-quit-2").addEventListener("click", () => {
    if (api) api.quit();
  });

  // ---------- 初始化 ----------
  resetSteps();
  if (!api) {
    // 纯浏览器预览 / preload 缺失：静态展示等待态
    subtitle.textContent = "等待主进程连接…";
    stepNote.textContent = "Startup Window 已打开，等待 Electron 主进程推送状态。";
    return;
  }

  api.onEvent(onEvent);
  api
    .getState()
    .then((snapshot) => {
      // 快照 = 事件日志（数组）：按序回放，恢复窗口最新状态
      if (Array.isArray(snapshot)) {
        for (const event of snapshot) onEvent(event);
      }
    })
    .catch(() => {
      /* 快照不可用不影响事件流 */
    });
})();
