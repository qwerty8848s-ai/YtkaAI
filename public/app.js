const tg = window.Telegram?.WebApp;
const byId = id => document.getElementById(id);
const model = byId('model');
const sleep = byId('sleep');
let status;
let dirty = false;
let sending = false;
let refreshing = false;

tg?.ready();
tg?.expand();
tg?.setHeaderColor?.('#101315');
tg?.setBackgroundColor?.('#101315');

async function api(path, data) {
  const response = await fetch('/api/' + path, {
    method: data ? 'POST' : 'GET',
    headers: { 'x-telegram-init-data': tg.initData, ...(data ? { 'content-type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Запрос не выполнен.');
  return result;
}

function notice(text = '', error = false) {
  const element = byId('notice');
  element.textContent = text;
  element.dataset.error = String(error);
}

function render() {
  if (!status) return;
  const phase = status.drain ? 'stopping' : status.phase;
  const labels = { asleep: 'Спит', starting: 'Запускается', running: 'Работает', stopping: 'Выключается' };
  byId('phase').textContent = labels[phase] || 'Неизвестно';
  byId('indicator').dataset.phase = phase;
  byId('status-detail').textContent = status.error || (status.drain
    ? 'Выключение после завершения текущего запроса.'
    : (status.backend === 'codespaces' ? 'GitHub Codespaces' : 'Собственный Linux-хост'));
  byId('start').disabled = sending || phase !== 'asleep';
  byId('stop').disabled = sending || phase === 'asleep' || phase === 'stopping';
  for (const element of [model, sleep, byId('save')]) element.disabled = sending;
  if (!dirty) {
    model.replaceChildren(...status.models.map(id => new Option(id, id)));
    model.value = status.models.includes(status.model) ? status.model : status.models[0];
    sleep.value = status.sleepMinutes;
  }
}

async function updateStatus() {
  if (refreshing || sending) return;
  refreshing = true;
  try {
    status = await api('status');
    render();
  } catch (error) {
    notice(error.message, true);
    if (!status) byId('phase').textContent = 'Статус недоступен';
  } finally {
    refreshing = false;
  }
}

async function updateUsage() {
  try {
    const usage = await api('usage');
    const progress = byId('progress');
    progress.hidden = usage.used === null;
    if (usage.used === null) {
      byId('amount').textContent = 'Нет данных';
      byId('usage-detail').textContent = usage.unavailable ? 'GitHub Billing временно недоступен' : 'Подключите GitHub Billing';
      return;
    }
    const format = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
    byId('amount').textContent = format.format(usage.used) + ' / ' + format.format(usage.limit) + ' ядро-часов';
    byId('usage-detail').textContent = 'Учёт GitHub • ' + new Intl.DateTimeFormat('ru', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(usage.updatedAt));
    progress.max = usage.limit;
    progress.value = usage.used;
  } catch {
    byId('usage-detail').textContent = 'Данные GitHub Billing недоступны';
  }
}

async function act(path, data, message) {
  sending = true;
  render();
  notice();
  try {
    await api(path, data);
    if (path === 'settings') dirty = false;
    notice(message);
    status = await api('status');
  } catch (error) {
    notice(error.message, true);
  } finally {
    sending = false;
    render();
  }
}

if (tg?.initData) {
  byId('start').addEventListener('click', () => act('power', { action: 'start' }, 'Запрос на запуск отправлен.'));
  byId('stop').addEventListener('click', () => act('power', { action: 'stop' }, 'Запрос на выключение отправлен.'));
  byId('settings').addEventListener('input', () => { dirty = true; });
  byId('settings').addEventListener('submit', event => {
    event.preventDefault();
    void act('settings', { model: model.value, sleepMinutes: sleep.valueAsNumber }, 'Настройки сохранены.');
  });
  void updateStatus();
  void updateUsage();
  setInterval(() => { if (!document.hidden) void updateStatus(); }, 5000);
  setInterval(() => { if (!document.hidden) void updateUsage(); }, 300000);
} else {
  byId('phase').textContent = 'Откройте в Telegram';
  byId('status-detail').textContent = 'Панель доступна из меню бота.';
}
