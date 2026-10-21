// ═══════════════════════════════════════════════════════════
//  app/report.js — модалка жалобы на игрока
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного app.js в рамках рефакторинга.
//  Код не изменён. Файл — классический скрипт в глобальной области,
//  подключается после /js/app/core.js в исходном порядке следования.

function showReportModal(targetUsername) {
  let modal = document.getElementById('modal-report');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-report';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
  }

  modal.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'modal';
  box.style.cssText = 'position:relative;max-width:420px';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.onclick = () => modal.classList.remove('open');
  box.appendChild(closeBtn);

  const title = document.createElement('h2');
  title.style.cssText = 'font-family:var(--font-display);font-size:20px;margin-bottom:8px';
  title.textContent = '🚩 Жалоба на ' + targetUsername;
  box.appendChild(title);

  const sub = document.createElement('p');
  sub.style.cssText = 'color:var(--text-secondary);font-size:13px;margin-bottom:20px';
  sub.textContent = 'Администратор рассмотрит вашу жалобу';
  box.appendChild(sub);

  // Причина
  const reasonLabel = document.createElement('div');
  reasonLabel.className = 'form-label';
  reasonLabel.textContent = 'Причина жалобы';
  box.appendChild(reasonLabel);

  const reasonSel = document.createElement('select');
  reasonSel.className = 'form-input';
  reasonSel.style.marginBottom = '14px';
  [
    ['cheat',     '🤖 Использование читов/движка'],
    ['abuse',     '🤬 Оскорбления в чате'],
    ['disconnect','🔌 Намеренные дисконнекты'],
    ['multiaccounting', '👥 Мульти-аккаунтинг'],
    ['spam',      '📢 Спам'],
    ['other',     '❓ Другое'],
  ].forEach(([val, label]) => {
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = label;
    reasonSel.appendChild(opt);
  });
  box.appendChild(reasonSel);

  // Детали
  const detailsLabel = document.createElement('div');
  detailsLabel.className = 'form-label';
  detailsLabel.textContent = 'Подробности (необязательно)';
  box.appendChild(detailsLabel);

  const detailsArea = document.createElement('textarea');
  detailsArea.className = 'form-input';
  detailsArea.rows = 3;
  detailsArea.placeholder = 'Опишите ситуацию...';
  detailsArea.maxLength = 500;
  detailsArea.style.cssText = 'resize:vertical;margin-bottom:20px';
  box.appendChild(detailsArea);

  // Кнопки
  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = 'Отмена';
  cancelBtn.onclick = () => modal.classList.remove('open');

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = 'Отправить жалобу';
  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Отправка...';
    try {
      await apiPost('/report', {
        targetUsername,
        reason: reasonSel.value,
        details: detailsArea.value.trim()
      });
      modal.classList.remove('open');
      toast('Жалоба отправлена. Спасибо!', 'success');
    } catch(e) {
      toast(e.message || 'Ошибка', 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Отправить жалобу';
    }
  });

  btns.appendChild(cancelBtn);
  btns.appendChild(submitBtn);
  box.appendChild(btns);

  modal.appendChild(box);
  modal.classList.add('open');
}

// ─── АДМИН ПАНЕЛЬ ─────────────────────────────────────────────
pages['admin'] = async () => {
  // Проверка на клиенте — быстрый фильтр UI
  if (!currentUser || currentUser.role !== 'admin') {
    showPage('home'); return;
  }
  // Дополнительная серверная проверка: убеждаемся что роль не подделана локально
  try {
    const me = await apiGet('/me');
    if (!me || me.role !== 'admin') { currentUser = null; updateAuthUI(); showPage('home'); return; }
  } catch { showPage('home'); return; }
  await adminLoadUsers();
};
