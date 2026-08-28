import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

// v0.11.0 起临时管理员凭证只驻留内存；启动时清除旧版本遗留的完整 STS 密钥。
try {
  Object.keys(sessionStorage)
    .filter(key => key.startsWith('awstool:tempCreds:'))
    .forEach(key => sessionStorage.removeItem(key));
} catch { /* 浏览器禁用存储时无需处理 */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
