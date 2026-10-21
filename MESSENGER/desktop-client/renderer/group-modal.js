// ============================================================================
//  Окно «Группа»: новая группа, название и участники, выйти, удалить
//
//  Общее для списка сотрудников (шестерёнка у группы) и окна чата группы (шестерёнка
//  рядом с «Историей») — одно и то же окно в обоих местах. Раньше жило только в roster.js.
//
//  В списке участников (решение пользователя 2026-10-21): поиск по имени, а те, кто уже
//  в группе, — всегда сверху, под ними остальные; внутри — по алфавиту.
//
//  Нужно из ui-kit.js: uiIcon, uiAlert, uiConfirm, escapeHtml.
// ============================================================================
(function () {
  const nameOf = (u) => u.display_name || u.username || '';
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), 'ru');

  /**
   * mode — 'create' | 'manage'; group — { id, name } для 'manage'; me — текущий сотрудник;
   * users — все сотрудники (кого можно добавить); memberIds — нынешние участники;
   * canManage — может ли менять состав и название; request(method, path, body) — запрос к
   * серверу, бросает Error с текстом сервера; onChanged(kind) — 'saved' | 'left' | 'deleted'.
   */
  function open({ mode, group, me, users, memberIds = [], canManage, request, onChanged }) {
    const current = new Set(memberIds.length ? memberIds : [me.id]);
    const others = users.filter((u) => u.id !== me.id); // себя в списке нет: участие и так гарантировано
    // Участники — сверху, остальные — ниже; порядок задаётся при открытии и не скачет от галочек.
    const ordered = [...others.filter((u) => current.has(u.id)).sort(byName), ...others.filter((u) => !current.has(u.id)).sort(byName)];
    const shown = canManage ? ordered : ordered.filter((u) => current.has(u.id));

    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ui-modal-box group-modal-box';
    const rowHtml = (u) => canManage
      ? `<label class="gm-member" data-name="${escapeHtml(nameOf(u).toLowerCase())}"><input type="checkbox" data-uid="${u.id}"${current.has(u.id) ? ' checked' : ''}><span class="n">${escapeHtml(nameOf(u))}</span></label>`
      : `<div class="gm-member-name" data-name="${escapeHtml(nameOf(u).toLowerCase())}">${escapeHtml(nameOf(u))}</div>`;
    box.innerHTML = `
      <div class="ui-modal-title">${uiIcon('group')} ${mode === 'create' ? 'Новая группа' : escapeHtml(group.name)}</div>
      ${canManage ? `<div class="gm-field"><label>Название</label><input type="text" id="gmName" maxlength="80" value="${mode === 'manage' ? escapeHtml(group.name) : ''}" placeholder="Например, Отдел статистики"></div>` : ''}
      <div class="gm-field">
        <label id="gmCount"></label>
        <input type="text" id="gmSearch" class="gm-search" placeholder="Поиск сотрудника" autocomplete="off">
        <div class="${canManage ? 'gm-members' : 'gm-readonly-members'}" id="gmList">${shown.map(rowHtml).join('')}
          <div class="gm-empty" id="gmEmpty" hidden>Никого не найдено</div>
        </div>
      </div>
      <div class="ui-modal-actions" style="margin-top:6px; flex-wrap:wrap;">
        ${mode === 'manage' ? '<button class="ui-btn-ghost" id="gmLeave">Покинуть группу</button>' : ''}
        ${mode === 'manage' && canManage ? '<button class="ui-btn-danger" id="gmDelete">Удалить</button>' : ''}
        <button class="ui-btn-ghost" id="gmCancel">${canManage ? 'Отмена' : 'Закрыть'}</button>
        ${canManage ? '<button class="ui-btn-primary" id="gmSave">Сохранить</button>' : ''}
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const $ = (sel) => box.querySelector(sel);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    $('#gmCancel').onclick = close;

    // Сколько в группе (с собой) — меняется вместе с галочками.
    const paintCount = () => {
      const n = canManage ? box.querySelectorAll('#gmList input[type=checkbox]:checked').length + 1 : current.size;
      $('#gmCount').textContent = `Участники (${n})`;
    };
    paintCount();
    box.querySelectorAll('#gmList input[type=checkbox]').forEach((cb) => { cb.onchange = paintCount; });

    // Поиск: прячем строки, галочки при этом не теряются.
    $('#gmSearch').oninput = () => {
      const q = $('#gmSearch').value.trim().toLowerCase();
      let visible = 0;
      box.querySelectorAll('#gmList [data-name]').forEach((row) => {
        const hit = !q || row.dataset.name.includes(q);
        row.hidden = !hit;
        if (hit) visible += 1;
      });
      $('#gmEmpty').hidden = visible > 0;
    };
    setTimeout(() => (canManage && mode === 'create' ? $('#gmName') : $('#gmSearch')).focus(), 0);

    if (canManage) {
      $('#gmSave').onclick = async () => {
        const name = $('#gmName').value.trim();
        if (!name) return uiAlert('Введите название группы', 'Пустое название');
        const checked = [...box.querySelectorAll('#gmList input[type=checkbox]:checked')].map((el) => Number(el.dataset.uid));
        try {
          if (mode === 'create') {
            await request('POST', '/api/groups', { name, memberIds: checked });
          } else {
            if (name !== group.name) await request('PATCH', `/api/groups/${group.id}`, { name });
            const toAdd = checked.filter((id) => !current.has(id));
            const toRemove = [...current].filter((id) => id !== me.id && !checked.includes(id));
            if (toAdd.length) await request('POST', `/api/groups/${group.id}/members`, { userIds: toAdd });
            for (const uid of toRemove) await request('DELETE', `/api/groups/${group.id}/members/${uid}`);
          }
          close();
          if (onChanged) await onChanged('saved');
        } catch (e) { uiAlert(e.message, 'Не удалось сохранить'); }
      };
    }
    if (mode === 'manage') {
      $('#gmLeave').onclick = async () => {
        const ok = await uiConfirm(`Покинуть группу «${group.name}»? Вернуться обратно можно будет, только если вас снова добавят.`, { title: 'Покинуть группу', okText: 'Покинуть', danger: true });
        if (!ok) return;
        try {
          await request('DELETE', `/api/groups/${group.id}/members/${me.id}`);
          close();
          if (onChanged) await onChanged('left');
        } catch (e) { uiAlert(e.message, 'Не удалось выйти из группы'); }
      };
      if (canManage) {
        $('#gmDelete').onclick = async () => {
          const ok = await uiConfirm(`Удалить группу «${group.name}» без возможности восстановления? Переписка останется в базе, но открыть её будет уже нельзя.`, { title: 'Удалить группу', okText: 'Удалить', danger: true });
          if (!ok) return;
          try {
            await request('DELETE', `/api/groups/${group.id}`);
            close();
            if (onChanged) await onChanged('deleted');
          } catch (e) { uiAlert(e.message, 'Не удалось удалить группу'); }
        };
      }
    }
  }

  window.IskraGroupModal = { open };
})();
