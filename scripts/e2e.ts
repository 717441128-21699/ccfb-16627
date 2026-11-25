/**
 * 浏览器端到端冒烟（puppeteer-core 驱动本机 Chrome）：
 *  启动页 → 点击启动仿真 → AudioWorklet 装载 → 24 卡片渲染 →
 *  注入故障 → 状态灯变化/告警 → 四个页面路由可渲染、无控制台错误
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:4173/';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fail {
  name: string;
  detail?: string;
}
const fails: Fail[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fails.push({ name, detail });
    console.error(`  ✗ ${name} ${detail}`);
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`PAGEERROR: ${err.message}`));
  page.on('requestfailed', (req) => consoleErrors.push(`REQFAIL: ${req.url()} ${req.failure()?.errorText}`));
  page.on('response', (res) => {
    if (res.status() >= 400) consoleErrors.push(`HTTP${res.status()}: ${res.url()}`);
  });

  console.log('\n[E1] 启动页与仿真启动');
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-now');
  await page.click('#start-now');
  await sleep(5000);

  const badge = await page.$eval('#mode-badge', (el) => el.textContent);
  check('模式徽标切换为仿真模式', !!badge && badge.includes('仿真'), badge ?? '');

  const cardCount = await page.$$eval('.burner-card', (els) => els.length);
  check('总览渲染 24 张燃烧器卡片', cardCount === 24, `got ${cardCount}`);

  const canvasCount = await page.$$eval('.burner-card canvas', (els) => els.length);
  check('24 张卡片均含频谱 canvas', canvasCount === 24, `got ${canvasCount}`);

  // 等待分析帧到达：卡片指标文本从占位变为数值
  await sleep(3000);
  const freqText = await page.$eval('.burner-card .m-freq', (el) => el.textContent);
  check('分析帧已到达（频率指标更新为 Hz 或“无峰”）', !!freqText && /Hz|无峰/.test(freqText), freqText ?? '');

  console.log('\n[E2] 注入故障后的状态演进');
  await page.click('#btn-fault');
  // 故障 onset 约 0–12s，等待起振与增长率转正（含 3 帧确认 ≈ 1s）
  await sleep(16000);
  const nonNormal = await page.$$eval(
    '.burner-card .status-dot',
    (els) => els.filter((e) => !e.className.includes('normal')).length,
  );
  check('至少 1 路状态灯脱离 normal（起振被检出）', nonNormal >= 1, `non-normal=${nonNormal}`);

  const kpiDanger = await page.$eval('#kpi-danger', (el) => el.textContent);
  const kpiWarn = await page.$eval('#kpi-warning', (el) => el.textContent);
  check('KPI 统计有数值输出', kpiDanger !== '–' && kpiWarn !== '–', `danger=${kpiDanger} warn=${kpiWarn}`);

  // 进入首个异常卡片的单路页
  await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.burner-card')).find((c) =>
      !c.querySelector('.status-dot')!.className.includes('normal'),
    );
    (card as HTMLElement)?.click();
  });
  await sleep(2500);
  const hash = await page.evaluate(() => location.hash);
  check('路由进入单路频谱页', hash.includes('#/channel/'), hash);
  const modeRows = await page.$$eval('#mode-rows tr', (els) => els.length);
  check('单路页展示理论模态表（5 阶模态）', modeRows === 5, `rows=${modeRows}`);
  const specW = await page.$eval('#spec-canvas', (el) => (el as HTMLCanvasElement).width);
  check('频谱 canvas 已实际绘制（width>0）', specW > 0, `width=${specW}`);

  console.log('\n[E3] 其余页面路由');
  await page.goto(`${URL}#/alerts`, { waitUntil: 'networkidle0' });
  await sleep(1000);
  check('预警记录页渲染表格', (await page.$('#alert-tbody')) !== null);
  const alertRows = await page.$$eval('#alert-tbody tr', (els) => els.length);
  check('故障期间已产生预警或抑制记录', alertRows >= 1, `rows=${alertRows}`);

  await page.goto(`${URL}#/reversal`, { waitUntil: 'networkidle0' });
  await sleep(1000);
  check('换火页 KPI 与时间轴渲染', (await page.$('#timeline')) !== null && (await page.$('#k-side')) !== null);
  const sideText = await page.$eval('#k-side', (el) => el.textContent);
  check('当前燃烧侧有取值', sideText === '左侧' || sideText === '右侧', sideText ?? '');

  await page.goto(`${URL}#/datasets`, { waitUntil: 'networkidle0' });
  await sleep(1000);
  const dsRows = await page.$$eval('#ds-tbody tr', (els) => els.length);
  check('燃烧数据页展示 6 组数据', dsRows === 6, `rows=${dsRows}`);
  const canvasW = await page.$eval('#lambda-canvas', (el) => (el as HTMLCanvasElement).width);
  check('λ 曲线 canvas 已绘制', canvasW > 0);

  console.log('\n[E4] 控制台错误检查');
  check('全程无 JavaScript 控制台错误', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 500));

  console.log(`\n浏览器 E2E 结果：${fails.length === 0 ? '全部通过' : `${fails.length} 项失败`}\n`);
} finally {
  await browser.close();
}
if (fails.length > 0) process.exit(1);
