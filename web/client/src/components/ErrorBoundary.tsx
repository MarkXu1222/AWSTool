import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Button, Result } from 'antd';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  /** 组件栈：定位是哪个组件抛的，比 error.stack（压缩后全是单字母）有用得多 */
  componentStack: string;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, componentStack: '' };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, info.componentStack);
    this.setState({ componentStack: info.componentStack || '' });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, componentStack: '' });
  };

  /** 复制完整报错，方便直接贴给维护者定位 */
  handleCopy = () => {
    const { error, componentStack } = this.state;
    const text = [
      `错误：${error?.message || '(无消息)'}`,
      `页面：${window.location.hash || window.location.pathname}`,
      `时间：${new Date().toISOString()}`,
      '',
      '--- 堆栈 ---',
      error?.stack || '(无)',
      '',
      '--- 组件栈 ---',
      componentStack || '(无)',
    ].join('\n');
    navigator.clipboard?.writeText(text);
  };

  render() {
    if (this.state.hasError) {
      const { error, componentStack } = this.state;
      // 把报错直接显示出来。原来只 console.error，用户截图只有一句
      // 「页面出错了」，定位得靠猜 —— 实测排查一次要来回好几轮。
      return (
        <div style={{ display: 'flex', justifyContent: 'center',
          alignItems: 'center', minHeight: '100vh', padding: 24 }}>
          <Result
            status="error"
            title="页面出错了"
            subTitle={error?.message || '抱歉，页面渲染时发生了错误。请尝试重试。'}
            extra={[
              <Button key="retry" type="primary" onClick={this.handleRetry}>重试</Button>,
              <Button key="copy" onClick={this.handleCopy}>复制报错详情</Button>,
            ]}
          >
            {(error?.stack || componentStack) && (
              <details style={{ maxWidth: 900, margin: '0 auto', textAlign: 'left' }}>
                <summary style={{ cursor: 'pointer', color: '#8c8c8c' }}>
                  展开技术细节
                </summary>
                <pre style={{ fontSize: 12, lineHeight: 1.5, overflow: 'auto',
                  maxHeight: 320, background: '#fafafa', padding: 12,
                  borderRadius: 4, marginTop: 8 }}>
                  {error?.stack || ''}
                  {componentStack ? `\n--- 组件栈 ---${componentStack}` : ''}
                </pre>
              </details>
            )}
          </Result>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
