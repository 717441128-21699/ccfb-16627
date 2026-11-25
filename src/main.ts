import './ui/styles.css';
import { App } from './ui/app';

new App().boot().catch((err) => {
  console.error(err);
  const el = document.createElement('div');
  el.style.cssText = 'padding:40px;color:#ff5d6c;font-family:monospace';
  el.textContent = `系统启动失败: ${(err as Error).message}`;
  document.body.appendChild(el);
});
