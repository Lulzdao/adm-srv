// Фронтенд платформы: дашборд, администрирование, сертификаты.
// Обычный скрипт без сборщика — функции общие для всех файлов страницы (см. index.html: app.js
// подключается первым, запуск — в нём по DOMContentLoaded, когда загружены все).
// ====== Дашборд ======
async function renderDashboard(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Статистика</div></div><div class="page"><div class="spinner">Загрузка…</div></div>`;
  try {
    // Раньше здесь скачивался весь список заявок, чтобы посчитать в браузере
    // шесть чисел и гистограмму: 1,87 МБ ради полутора сотен байт полезного.
    // Теперь всё считает SQL одним проходом.
    const stats = await api("/admin/stats");
    const open = stats.open;
    const critical = stats.critical;
    const closed = stats.closedTotal;

    // Состав и порядок отделов берём из своего справочника, а не из ответа:
    // отдел, по которому заявок ещё не было, должен остаться на гистограмме.
    const byCategory = state.departments.map(d => ({ name: d.name, count: (stats.byCategory || {})[d.name] || 0 }));
    const maxCount = Math.max(...byCategory.map(c => c.count), 1);

    const topList = (rows) => rows.length
      ? rows.map((r, i) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;${i > 0 ? "border-top:1px solid var(--line-soft);" : ""}">
          <span style="font-size:12.5px;">${i + 1}. ${esc(r.full_name)}</span>
          <span class="mono" style="font-size:12.5px;color:var(--ink-soft);">${r.n} закрыто</span>
        </div>`).join("")
      : `<div style="font-size:12.5px;color:var(--ink-soft);padding:8px 0;">Пока нет закрытых заявок за этот период.</div>`;

    main.querySelector(".page").innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">ОТКРЫТО СЕЙЧАС</div><div class="stat-value mono">${open}</div></div>
        <div class="stat-card"><div class="stat-label">КРИТИЧНЫХ АКТИВНЫХ</div><div class="stat-value mono" style="color:${critical ? "var(--red)" : "var(--ink)"};">${critical}</div></div>
        <div class="stat-card"><div class="stat-label">ЗАКРЫТО ЗА 7 ДНЕЙ</div><div class="stat-value mono">${stats.closed7}</div></div>
        <div class="stat-card"><div class="stat-label">ЗАКРЫТО ЗА 30 ДНЕЙ</div><div class="stat-value mono">${stats.closed30}</div></div>
      </div>
      <div class="stat-grid" style="grid-template-columns:1fr 1fr;">
        <div class="stat-card"><div class="stat-label">ЗАКРЫТО ВСЕГО</div><div class="stat-value mono">${closed}</div></div>
        <div class="stat-card"><div class="stat-label">ВСЕГО ЗАЯВОК</div><div class="stat-value mono">${stats.total}</div></div>
      </div>
      <div class="card" style="margin-bottom:20px;">
        <div class="section-label" style="margin-bottom:16px;">Заявки по отделам</div>
        ${byCategory.map(c => `
          <div class="bar-row">
            <div style="width:130px;font-size:12.5px;">${esc(c.name)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${(c.count/maxCount)*100}%"></div></div>
            <div style="width:20px;font-size:12px;text-align:right;" class="mono">${c.count}</div>
          </div>`).join("")}
      </div>
      <div style="display:flex;gap:14px;">
        <div class="card" style="flex:1;">
          <div class="section-label">Топ по закрытым — неделя</div>
          ${topList(stats.topWeek)}
        </div>
        <div class="card" style="flex:1;">
          <div class="section-label">Топ по закрытым — месяц</div>
          ${topList(stats.topMonth)}
        </div>
      </div>`;
  } catch (e) {
    main.querySelector(".page").innerHTML = `<div class="empty-state">Не удалось загрузить статистику: ${esc(e.message)}</div>`;
  }
}

// ====== Администрирование ======
async function renderAdmin(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Администрирование</div></div><div class="page"><div class="spinner">Загрузка…</div></div>`;
  try {
    const [{ departments: deptSettings, adminGroups, domainLabels }, { admins, executors }, backupInfo] = await Promise.all([
      api("/admin/settings"), api("/admin/admins"), api("/admin/backup"),
    ]);
    const ИМЯ_ДОМЕНА = domainLabels || { A: "rosstat.local", B: "in.local" };

    const ROLE_LABEL = Object.fromEntries(deptSettings.map(d => [d.role, d.name]));

    const groupRow = (id, label, value, placeholder) => `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
        <span style="width:104px;font-size:12px;color:var(--ink-soft);font-weight:600;white-space:nowrap;">${label}</span>
        <input class="input" id="${id}" style="flex:1;" value="${esc(value)}" placeholder="${esc(placeholder)}">
      </div>`;

    const groupCard = (dept) => `
      <div class="card" style="margin-bottom:14px;">
        <div class="section-label">Группа АД — исполнители отдела ${esc(dept.name)}</div>
        ${groupRow(`group_${dept.role}_A`, esc(ИМЯ_ДОМЕНА.A), dept.groupA, "имя группы")}
        ${groupRow(`group_${dept.role}_B`, esc(ИМЯ_ДОМЕНА.B), dept.groupB, "имя группы")}
      </div>`;

    const человек = (a, показатьРоль) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid var(--line-soft);">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:13px;font-weight:600;">${esc(a.full_name)}</span>
          <span class="mono" style="font-size:12px;color:var(--ink-soft);">${esc(a.ad_login)}</span>
          ${показатьРоль ? (a.roles || [a.role]).map(r => `<span class="badge" style="color:var(--wire);background:var(--wire-soft);">${esc(ROLE_LABEL[r] || r)}</span>`).join("") : ""}
          <span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">${a.last_domain === "local" ? "Локальный" : esc(ИМЯ_ДОМЕНА[a.last_domain] || a.last_domain)}</span>
        </div>
        <span style="font-size:11px;color:var(--ink-soft);">вход ${fmtDate(a.last_login_at)}</span>
      </div>`;

    const пусто = (текст) => `<div style="font-size:12.5px;color:var(--ink-soft);">${текст}</div>`;

    main.querySelector(".page").innerHTML = `
      <div class="card" style="margin-bottom:14px;">
        <div class="section-label">Администраторы платформы</div>
        <div style="font-size:11.5px;color:var(--ink-soft);margin-bottom:6px;">
          Права даёт членство в группе, указанной в <code class="mono">.env</code> на сервере:
          <span class="mono">${esc(adminGroups.A || "— не задана —")}</span> (${esc(ИМЯ_ДОМЕНА.A)}),
          <span class="mono">${esc(adminGroups.B || "— не задана —")}</span> (${esc(ИМЯ_ДОМЕНА.B)}).
          Отсюда список не редактируется и группами отделов ниже не расширяется.
        </div>
        ${admins.length ? admins.map(a => человек(a, false)).join("") : пусто("Ни один администратор ещё не входил.")}
      </div>

      <div class="card" style="margin-bottom:20px;">
        <div class="section-label">Исполнители по отделам</div>
        <div style="font-size:11.5px;color:var(--ink-soft);margin-bottom:6px;">
          Читается из членства в группах отделов на момент последнего входа. Прав администратора не даёт.
        </div>
        ${executors.length ? executors.map(a => человек(a, true)).join("") : пусто("Пока никто не входил под ролью исполнителя.")}
      </div>

      <div class="card" style="margin-bottom:20px;">
        <div class="section-label">Резервные копии баз</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:14px;">
          Раз в месяц каждая база копируется в отдельный файл (<span class="mono">smdr-2026-10.db</span> и т.п.),
          старые копии не удаляются. Лучше класть их в сетевую папку, а не на тот же диск, что и базы.
          Путь — сетевой: <span class="mono">\\\\сервер\\папка\\backups</span>. Диск, подключённый буквой
          (<span class="mono">Z:\\</span>), служба не видит — он есть только в сеансе пользователя.
          Права на запись нужны учётной записи компьютера, под ней служба ходит в сеть.
        </div>
        <div style="font-size:12.5px;margin-bottom:12px;">Сейчас копии кладутся в
          <span class="mono">${esc(backupInfo.dir)}</span>
          <span style="color:var(--ink-soft);">(${{ panel: "задано здесь", env: "задано в .env на сервере (BACKUP_DIR)", default: "папка по умолчанию" }[backupInfo.source] || ""})</span>
        </div>
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px;">
          <div style="flex:1;min-width:260px;">
            <div class="field-label">Папка для копий (пусто — ${backupInfo.envDir ? "из .env" : "папка по умолчанию"})</div>
            <input class="input mono" id="bkDir" value="${esc(backupInfo.panelDir)}" placeholder="${esc(backupInfo.envDir || backupInfo.defaultDir)}" style="width:100%;" />
          </div>
          <button class="btn btn-ghost" id="bkCheck">Проверить</button>
          <button class="btn btn-wire" id="bkSave">Сохранить</button>
          <button class="btn btn-ghost" id="bkRun">Сделать копию сейчас</button>
        </div>
        <div id="bkMsg" style="font-size:12px;margin-bottom:10px;"></div>
        <div class="field-label">Последние копии в этой папке</div>
        ${Array.isArray(backupInfo.copies) && backupInfo.copies.length
          ? `<div style="font-size:12.5px;display:grid;grid-template-columns:auto auto auto;gap:4px 18px;justify-content:start;">
              ${backupInfo.copies.map(c => `<span class="mono">${esc(c.name)}</span>
                <span style="color:var(--ink-soft);">${(c.size / 1048576).toFixed(1)} МБ</span>
                <span style="color:var(--ink-soft);">${fmtDate(c.modified)}</span>`).join("")}
            </div>`
          : `<div style="font-size:12px;color:var(--ink-soft);">${esc((backupInfo.copies && backupInfo.copies.error) || "Копий пока нет — первая появится при ближайшем ежемесячном обходе или по кнопке «Сделать копию сейчас».")}</div>`}
      </div>

      <div style="display:flex;gap:20px;align-items:flex-start;">
        <div style="flex:1;min-width:0;">
          <div class="card">
            <div class="section-label">Как добавить ещё одну группу исполнителей</div>
            <div style="font-size:12.5px;line-height:1.7;color:var(--ink);">
              1. На сервере откройте файл <code class="mono" style="background:var(--line-soft);padding:1px 5px;border-radius:3px;">config/departments.js</code><br>
              2. Добавьте одну строку в список, например:<br>
              <code class="mono" style="display:block;background:var(--line-soft);padding:8px 10px;border-radius:5px;margin:6px 0;font-size:11.5px;">{ name: "БУХ", prefix: "БУХ", role: "buh" }</code>
              3. Перезапустите сервер (<code class="mono" style="background:var(--line-soft);padding:1px 5px;border-radius:3px;">npm start</code>)<br>
              4. Новый отдел появится в форме создания заявки, в фильтре списка и справа на этой странице — впишите туда название AD-группы, как для остальных отделов.
            </div>
          </div>
        </div>
        <div style="width:380px;flex-shrink:0;">
          ${deptSettings.map(groupCard).join("")}
          <button class="btn btn-wire" id="saveGroups" style="width:100%;justify-content:center;">Сохранить</button>
          <div id="saveMsg" style="margin-top:8px;font-size:12px;color:var(--green);display:none;text-align:center;">Сохранено</div>
        </div>
      </div>`;

    // ---- Резервные копии баз (раньше — «Оповещения → Отправка») ----
    const bkMsg = main.querySelector("#bkMsg");
    const bkShow = (ok, text, hint) => {
      bkMsg.style.color = ok ? "var(--green)" : "var(--red)";
      bkMsg.innerHTML = esc(text) + (hint ? `<div style="color:var(--ink-soft);margin-top:4px;">${esc(hint)}</div>` : "");
    };
    main.querySelector("#bkCheck").onclick = async () => {
      const dir = main.querySelector("#bkDir").value.trim() || backupInfo.envDir || backupInfo.defaultDir;
      bkMsg.style.color = "var(--ink-soft)"; bkMsg.textContent = "Проверяю запись…";
      try {
        const r = await api("/admin/backup/check", { method: "POST", body: { dir } });
        if (r.ok) bkShow(true, `Запись в ${dir} работает — копии туда лягут.`);
        else bkShow(false, `Не получилось: ${r.error}`, r.hint);
      } catch (e) { bkShow(false, e.message); }
    };
    main.querySelector("#bkSave").onclick = async () => {
      bkMsg.style.color = "var(--ink-soft)"; bkMsg.textContent = "Проверяю и сохраняю…";
      try {
        const r = await api("/admin/backup", { method: "PUT", body: { dir: main.querySelector("#bkDir").value } });
        bkShow(true, `Сохранено: копии будут класться в ${r.dir}`);
        setTimeout(() => renderAdmin(main), 1800);
      } catch (e) { bkShow(false, e.message, e.hint); }
    };
    // То же задание планировщика, что и ежемесячный обход: результат виден и в «Оповещения → Отправка».
    main.querySelector("#bkRun").onclick = async () => {
      bkMsg.style.color = "var(--ink-soft)"; bkMsg.textContent = "Копирую базы…";
      try {
        const r = await api("/notifications/schedule/backup/run", { method: "POST", body: {} });
        if (r.ok) { bkShow(true, jobDetailText(r.detail)); setTimeout(() => renderAdmin(main), 2600); }
        else bkShow(false, r.error || r.skipped || "не выполнено");
      } catch (e) { bkShow(false, e.message, e.hint); }
    };

    document.getElementById("saveGroups").onclick = async () => {
      try {
        const payload = deptSettings.map(dept => ({
          role: dept.role,
          groupA: document.getElementById(`group_${dept.role}_A`).value.trim(),
          groupB: document.getElementById(`group_${dept.role}_B`).value.trim(),
        }));
        await api("/admin/settings", { method: "PUT", body: { departments: payload } });
        const msg = document.getElementById("saveMsg");
        msg.style.display = "block"; setTimeout(() => msg.style.display = "none", 2500);
      } catch (e) { toast(e.message, true); }
    };
  } catch (e) {
    main.querySelector(".page").innerHTML = `<div class="empty-state">Не удалось загрузить: ${esc(e.message)}</div>`;
  }
}

// ====== Сертификаты ======
// Экран про «сертификаты» — это на самом деле про две разные вещи, которые
// постоянно путают, и разница между ними определяет всю раскладку:
//
//   • СЕРТИФИКАТ СЕРВЕРА — что мы ПРЕДЪЯВЛЯЕМ клиентам. Это вся повседневная
//     работа: продлили — загрузили. Поэтому загрузка здесь же, на видном
//     месте, а не «положите файл вот в эту папку на сервере». Файл ОДИН и
//     общий с «Искрой»: обе службы на одной машине и отвечают на одно имя.
//
//   • ДОВЕРЕННЫЕ КОРНИ — кому верим МЫ, когда сами ходим наружу (LDAPS к
//     контроллерам домена, проксирование в «Искру»). Клиентов это не касается
//     совсем: они берут корни из хранилища Windows, куда те приезжают
//     групповыми политиками. На доменной машине раздел не нужен вообще,
//     поэтому он свёрнут и лежит внизу.

// Сертификат загрузили, а платформа работает по http — на https она перейдёт только после
// перезапуска. Спрашиваем: сейчас или позже. «Сейчас» — процесс завершается, служба NSSM поднимает
// его снова (routes/certificates.js, POST /restart); ждём, пока платформа ответит по https, и
// открываем её уже по https. Если платформа запущена не службой, кнопки «сейчас» нет — объясняем.
function askRestart(canRestart) {
  const httpsUrl = `https://${location.host}/#certs`;
  const m = asstModal("Сертификат сохранён", `
    <div style="font-size:13px;line-height:1.55;margin-bottom:14px;">
      Сейчас платформа работает по <b>http</b>. На https она перейдёт после перезапуска — на ходу
      включить шифрование нельзя.
      ${canRestart
        ? "Перезапустить сейчас? Пользователи на несколько секунд потеряют связь, открытые страницы переподключатся сами."
        : "Перезапустить отсюда нельзя: платформа запущена не службой. Перезапустите её вручную."}
      <div style="color:var(--ink-soft);margin-top:8px;">После перехода на https браузер попросит войти ещё раз — один
      раз: вход, сделанный по http, браузер на https не переносит. «Искра» читает тот же сертификат; на https она перейдёт
      после перезапуска своей службы.</div>
    </div>
    <div id="rsMsg" style="font-size:12.5px;margin-bottom:12px;"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;">
      <button class="btn btn-ghost" id="rsLater">${canRestart ? "Позже" : "Понятно"}</button>
      ${canRestart ? `<button class="btn btn-wire" id="rsNow">Перезапустить сейчас</button>` : ""}
    </div>`);
  const msg = m.el.querySelector("#rsMsg");
  m.el.querySelector("#rsLater").onclick = () => {
    m.close();
    toast("Сертификат начнёт действовать после перезапуска службы платформы.");
  };
  const now = m.el.querySelector("#rsNow");
  if (!now) return;
  now.onclick = async () => {
    now.disabled = true; m.el.querySelector("#rsLater").disabled = true;
    msg.style.color = "var(--ink-soft)"; msg.textContent = "Перезапускаю платформу…";
    try {
      await api("/certificates/restart", { method: "POST", body: {} });
    } catch (e) {
      msg.style.color = "var(--red)"; msg.textContent = e.message;
      now.disabled = false; m.el.querySelector("#rsLater").disabled = false;
      return;
    }
    // Ответ по https — значит, поднялась уже с сертификатом. Страница открыта по http, поэтому
    // спрашиваем «вслепую» (no-cors): нам важен сам факт ответа, а не его содержимое.
    const started = Date.now();
    const poll = async () => {
      try {
        await fetch(`https://${location.host}/api/health?ts=${Date.now()}`, { mode: "no-cors", cache: "no-store" });
        msg.style.color = "var(--green)"; msg.textContent = "Готово — открываю платформу по https…";
        setTimeout(() => { location.href = httpsUrl; }, 600);
        return;
      } catch { /* ещё не поднялась или сертификат браузеру не доверен */ }
      const sec = Math.round((Date.now() - started) / 1000);
      if (sec < 12) { msg.textContent = `Ждём, пока служба поднимется… ${sec} с`; setTimeout(poll, 1500); return; }
      // Служба поднимается за 5–10 с. Если проверка всё не проходит — скорее всего, браузер не доверяет
      // сертификату (самоподписанный, корня нет в Windows): тогда он сам покажет предупреждение на https-адресе.
      msg.innerHTML = `Открываю <a href="${esc(httpsUrl)}">${esc(httpsUrl)}</a>… Если браузер предупредит о
        сертификате — значит, он ему не доверяет (корня удостоверяющего центра нет в Windows).`;
      setTimeout(() => { location.href = httpsUrl; }, 1500);
    };
    setTimeout(poll, 3000);
  };
}

async function renderCertificates(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Сертификаты</div></div><div class="page"><div class="spinner">Загрузка…</div></div>`;

  const days = (n) => {
    if (n === null || n === undefined) return "";
    if (n < 0) return `<span class="badge" style="color:var(--red);background:var(--red-soft);">истёк ${-n} дн. назад</span>`;
    if (n < 30) return `<span class="badge" style="color:var(--amber);background:var(--amber-soft);">осталось ${n} дн.</span>`;
    return `<span class="badge" style="color:var(--green);background:var(--green-soft);">осталось ${n} дн.</span>`;
  };
  const row = (label, value) => `
    <div class="field-mini"><div class="field-mini-label">${esc(label)}</div>
    <div class="field-mini-value">${value}</div></div>`;

  try {
    const [server, trusted, mods] = await Promise.all([
      api("/certificates/server"), api("/certificates/trusted"), api("/certificates/modules"),
    ]);

    // Щит в шапке — по тем же свежим данным: раздел открывают и сразу после загрузки нового
    // сертификата (renderCertificates ниже), и ждать до получаса, пока щит спросит сервер сам, незачем.
    // Сертификат ещё разбирается (только что применён) — щит спросит сам при следующем переходе.
    certBadge = { at: server.secure && !server.certificate ? 0 : Date.now(), cert: server.certificate, secure: server.secure };
    const badgeBtn = document.getElementById("certsBtn");
    if (badgeBtn) applyCertBadge(badgeBtn);

    const c = server.certificate;
    const serverCard = !server.secure
      ? `<div class="warn-box">Платформа работает по HTTP — сертификат не задан. Пароли и переписка идут открытым текстом.</div>`
      : c
        ? `${row("Кому выдан", esc(c.subject || "—"))}
           ${row("Имена в сертификате (SAN)", `<span class="mono" style="font-size:12px;">${esc(c.san || "—")}</span>`)}
           ${row("Кем выдан", esc(c.issuer || "—"))}
           ${row("Действителен до", `${esc(c.validTo || "—")} ${days(certDaysLeft(c))}`)}
           ${row("Корень цепочки", esc(c.rootSubject || "—"))}
           ${row("Цепочка", c.chainComplete
              ? `<span class="badge" style="color:var(--green);background:var(--green-soft);">полная (${c.certificates} серт.)</span>`
              : `<span class="badge" style="color:var(--amber);background:var(--amber-soft);">неполная — клиент может не достроить доверие</span>`)}
           ${row("Отпечаток", `<span class="mono" style="font-size:11px;word-break:break-all;">${esc(c.fingerprint || "—")}</span>`)}`
        : `<div style="font-size:12.5px;color:var(--ink-soft);">Сертификат применён, подробности ещё читаются…</div>`;

    const rootRow = (r) => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--line-soft);">
        <div style="min-width:0;">
          <div style="font-size:13px;font-weight:600;">${esc(r.subject || r.file)}</div>
          <div style="font-size:11.5px;color:var(--ink-soft);">
            <span class="mono">${esc(r.file)}</span>${r.error ? ` · <span style="color:var(--red);">${esc(r.error)}</span>` : ""}
            ${r.warning ? ` · <span style="color:var(--amber);">${esc(r.warning)}</span>` : ""}
            ${r.selfSigned === false ? " · промежуточный, не корень" : ""}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
          ${r.daysLeft !== undefined && r.daysLeft !== null ? days(r.daysLeft) : ""}
          <button class="btn btn-ghost del-root" data-file="${esc(r.file)}">Удалить</button>
        </div>
      </div>`;

    const modRow = (m) => {
      let status;
      if (!m.secure) status = `<span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">без шифрования</span>`;
      else if (m.error) status = `<span class="badge" style="color:var(--red);background:var(--red-soft);">${esc(m.error)}</span>`;
      else if (!m.authorized) status = `<span class="badge" style="color:var(--red);background:var(--red-soft);">не проходит проверку: ${esc(m.authorizationError || "")}</span>`;
      else status = `<span class="badge" style="color:var(--green);background:var(--green-soft);">проверку проходит</span>`;
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--line-soft);">
          <div style="min-width:0;">
            <div style="font-size:13px;font-weight:600;">${esc(m.label)}</div>
            <div class="mono" style="font-size:11.5px;color:var(--ink-soft);">${esc(m.target)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
            ${m.certificate && m.certificate.daysLeft !== null ? days(m.certificate.daysLeft) : ""}
            ${status}
          </div>
        </div>`;
    };

    main.querySelector(".page").innerHTML = `
      <div style="max-width:900px;">
        <div>
          <div class="card" style="margin-bottom:20px;">
            <div class="section-label">Сертификат сервера — что мы предъявляем</div>
            <div style="font-size:12px;color:var(--ink-soft);margin-bottom:14px;">
              Сертификат один на обе службы: платформа и «Искра» стоят на одной машине и отвечают
              на одно имя. ${server.managedBy === "store"
                ? `Файл лежит в <span class="mono">${esc(server.sharedStore)}</span>; загрузить новый можно здесь же (форма ниже) или в панели «Искры» — разницы нет, файл тот же. Обе службы перечитывают его сами, без перезапуска.`
                : server.managedBy === "env"
                ? `Сейчас общее хранилище пустое, и работает запасной путь — переменная в <span class="mono">.env</span>: <span class="mono">${esc(server.where || "")}</span>. Такой сертификат <b>не общий</b> с «Искрой». Загрузите файл формой ниже — он ляжет в общее хранилище и сразу заменит сертификат из переменной: хранилище важнее.`
                : `Сертификата нет. Загрузите PFX формой ниже — он ляжет в общее хранилище; платформа перейдёт на https после перезапуска службы (с http на https на ходу не переключиться).`}
            </div>
            ${server.managedBy !== "store" ? `<div class="warn-box" style="margin-bottom:14px;">
              <div>
              Хранилище платформа ищет в <span class="mono">${esc(server.storeDir || "")}</span> — это должен быть
              каталог <span class="mono">certs</span> работающей «Искры». Если «Искра» стоит не там, укажите
              <span class="mono">SHARED_CERT_DIR=&lt;папка Искры&gt;\\certs</span> в <span class="mono">.env</span> и
              перезапустите платформу — иначе загруженный здесь файл «Искра» не увидит.
              </div>
            </div>` : ""}
            ${server.shadowedEnv ? `<div class="warn-box" style="margin-bottom:14px;">
              <div>
              В <span class="mono">.env</span> (или в окружении службы) задана переменная
              <span class="mono">${esc(server.shadowedEnv)}</span>, но она не используется: действует сертификат
              из общего хранилища. Уберите её — иначе, если файл из хранилища однажды удалят, платформа молча
              вернётся к старому сертификату из переменной.
              </div>
            </div>` : ""}
            ${serverCard}

            ${server.managedBy ? `
            <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line-soft);">
              <div class="section-label" style="margin-bottom:8px;">Заменить сертификат</div>
              <div style="font-size:12px;color:var(--ink-soft);margin-bottom:12px;">
                PFX (.pfx или .p12) — экспортированный из удостоверяющего центра домена вместе с
                закрытым ключом и всеми сертификатами пути. Файл сначала проверяется (пароль, срок,
                цепочка) и только потом заменяет действующий: испортить работающую платформу
                загрузкой не того файла нельзя. Прежний остаётся рядом с суффиксом
                <span class="mono">.bak</span>.
              </div>
              <div class="form-row" style="margin-bottom:12px;">
                <div>
                  <div class="field-label">Файл</div>
                  <input class="field-input" id="certFile" type="file" accept=".pfx,.p12" style="margin-bottom:0;padding:10px 12px;">
                </div>
                <div>
                  <div class="field-label">Пароль к файлу</div>
                  <input class="field-input" id="certPass" type="password" placeholder="если он есть" style="margin-bottom:0;">
                </div>
              </div>
              <button class="btn btn-wire" id="certUpload">Загрузить и применить</button>
              <div id="certMsg" style="margin-top:10px;font-size:12.5px;"></div>
            </div>` : ""}
          </div>

          <div class="card">
            <div class="section-label">Модули — что предъявляют они</div>
            <div style="font-size:12px;color:var(--ink-soft);margin-bottom:6px;">
              Платформа проверяет сертификат модуля по-настоящему, поэтому модуль должен быть
              адресован именем из его сертификата, а не по IP.
            </div>
            ${mods.modules.map(modRow).join("")}
          </div>
        </div>

      </div>

      <details class="card" style="margin-top:20px;">
        <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--ink-soft);">
          Доверенные корни — кому верим мы. Обычно трогать не нужно
        </summary>
        <div style="font-size:12px;color:var(--ink-soft);margin:14px 0 12px;max-width:760px;">
          Это не про клиентов: они берут корни из хранилища Windows, куда те приезжают групповыми
          политиками, и панель на это никак не влияет. Список ниже — про исходящие соединения самой
          платформы: LDAPS к контроллерам доменов и проверка сертификата «Искры» при
          проксировании. Удостоверяющий центр у нас один, и на доменной машине здесь не нужно
          ничего: платформа запускается с <span class="mono">--use-system-ca</span> и доверяет тому
          же хранилищу Windows. Раздел пригождается в двух случаях: машина вне домена и переходный
          период при смене УЦ. Файлы лежат в <span class="mono">${esc(trusted.dir)}</span>,
          подключаются переменной <span class="mono">NODE_EXTRA_CA_CERTS</span> и начинают
          действовать только после перезапуска платформы.
        </div>
        <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;">
          <div style="flex:1;min-width:320px;">
            ${trusted.roots.length ? trusted.roots.map(rootRow).join("")
              : `<div style="font-size:12.5px;color:var(--ink-soft);">Пока пусто — и это нормальное состояние.</div>`}
          </div>
          <div style="width:380px;flex-shrink:0;">
            <div class="field-label">Добавить корень</div>
            <input class="field-input" id="rootName" placeholder="например in-local-root.crt" style="margin-bottom:10px;">
            <textarea class="input" id="rootPem" rows="5" placeholder="-----BEGIN CERTIFICATE-----" style="width:100%;font-family:var(--mono);font-size:11px;margin-bottom:10px;"></textarea>
            <button class="btn btn-wire" id="addRoot" style="width:100%;justify-content:center;">Добавить</button>
            <div id="rootMsg" style="margin-top:8px;font-size:12px;text-align:center;"></div>
          </div>
        </div>
      </details>`;

    const uploadBtn = document.getElementById("certUpload");
    if (uploadBtn) uploadBtn.onclick = async () => {
      const msg = document.getElementById("certMsg");
      const input = document.getElementById("certFile");
      const file = input.files && input.files[0];
      if (!file) { msg.style.color = "var(--red)"; msg.textContent = "Выберите файл"; return; }
      msg.style.color = "var(--ink-soft)"; msg.textContent = "Проверяю файл…";
      try {
        // Читаем в base64 на клиенте: так тело остаётся обычным JSON и не
        // требует отдельной обработки multipart ради одного файла.
        const b64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1] || "");
          r.onerror = () => reject(new Error("Файл не читается"));
          r.readAsDataURL(file);
        });
        const res = await api("/certificates/server", {
          method: "POST",
          body: { pfx: b64, password: document.getElementById("certPass").value },
        });
        renderCertificates(main);
        if (res.restartRequired) askRestart(res.canRestart);
        else toast("Сертификат применён — перезапуск не нужен ни платформе, ни «Искре»: обе перечитывают общее хранилище сами.");
      } catch (e) { msg.style.color = "var(--red)"; msg.textContent = e.message; }
    };

    document.getElementById("addRoot").onclick = async () => {
      const msg = document.getElementById("rootMsg");
      msg.style.color = "var(--ink-soft)"; msg.textContent = "Проверяю…";
      try {
        await api("/certificates/trusted", {
          method: "POST",
          body: {
            name: document.getElementById("rootName").value.trim(),
            pem: document.getElementById("rootPem").value,
          },
        });
        renderCertificates(main);
        toast("Корень добавлен. Перезапустите платформу, чтобы он начал действовать.");
      } catch (e) { msg.style.color = "var(--red)"; msg.textContent = e.message; }
    };

    main.querySelectorAll(".del-root").forEach(btn => {
      btn.onclick = async () => {
        if (!confirm(`Удалить ${btn.dataset.file} из доверенных?`)) return;
        try {
          await api(`/certificates/trusted/${encodeURIComponent(btn.dataset.file)}`, { method: "DELETE" });
          renderCertificates(main);
        } catch (e) { toast(e.message, true); }
      };
    });
  } catch (e) {
    main.querySelector(".page").innerHTML = `<div class="empty-state">Не удалось загрузить: ${esc(e.message)}</div>`;
  }
}
