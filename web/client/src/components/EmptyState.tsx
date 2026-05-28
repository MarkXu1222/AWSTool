import React from 'react';
import { Empty } from 'antd';

interface EmptyStateProps {
  description?: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({ description = '暂无数据' }) => (
  <Empty description={description} style={{ padding: '40px 0' }} />
);

export default EmptyState;
