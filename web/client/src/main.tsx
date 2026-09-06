import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './styles/global.css';

// AntD 主题与 global.css 设计 token 合流：此前 AntD 默认蓝 #1677ff/圆角 6px
// 与自定义 token #2563eb/圆角 8px 双轨并存，靠 !important 硬扳。
// 这里是唯一的品牌色定义入口，与 :root CSS 变量保持一致。
const themeTokens = {
  colorPrimary: '#2563eb',
  colorSuccess: '#52c41a',
  colorWarning: '#faad14',
  colorError: '#ff4d4f',
  colorTextBase: '#1a2233',
  colorBgLayout: '#f4f5f7',
  borderRadius: 8,
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif",
};

// v0.11.0 起临时管理员凭证只驻留内存；启动时清除旧版本遗留的完整 STS 密钥。
try {
  Object.keys(sessionStorage)
    .filter(key => key.startsWith('awstool:tempCreds:'))
    .forEach(key => sessionStorage.removeItem(key));
} catch { /* 浏览器禁用存储时无需处理 */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: themeTokens }}>
      <App />
    </ConfigProvider>
  </React.StrictMode>
);
