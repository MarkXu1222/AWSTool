import React from 'react';
import { Button, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

export type TagResultStatus = 'verified' | 'create_failed' | 'write_failed' | 'read_failed' | 'mismatch';

export interface TagResultRow {
  /** 行唯一键：打 Tag 用 arn；创建用 `${region}|${modelId}` */
  key: string;
  region: string;
  name?: string;
  arn?: string;
  modelId?: string;
  status: TagResultStatus;
  oldMapValue?: string | null;
  actualMapValue?: string | null;
  error?: string;
}

export const TAG_STATUS_LABEL: Record<TagResultStatus, string> = {
  verified: '已核验',
  create_failed: '创建失败',
  write_failed: '写入失败',
  read_failed: '回查失败',
  mismatch: '值不一致',
};

const STATUS_ORDER: TagResultStatus[] = ['verified', 'mismatch', 'read_failed', 'write_failed', 'create_failed'];

const statusColor = (s: TagResultStatus) => (s === 'verified' ? 'success' : s === 'mismatch' ? 'warning' : 'error');

/**
 * 创建 / 打 Tag 的逐项结果。成功只认 AWS 回查一致（verified）；
 * 其余状态都算未完成，「重试未完成项」只重发这些。
 */
const BedrockTagResults: React.FC<{
  rows: TagResultRow[];
  retrying: boolean;
  onRetry: () => void;
  /** 有其它操作在跑时禁用重试（避免两批结果互相覆盖） */
  disabled?: boolean;
}> = ({ rows, retrying, onRetry, disabled }) => {
  const unfinished = rows.filter(r => r.status !== 'verified').length;
  const showOld = rows.some(r => r.oldMapValue !== undefined);
  const counts = STATUS_ORDER
    .map(s => [s, rows.filter(r => r.status === s).length] as const)
    .filter(([, n]) => n > 0);

  return (
    <div>
      <Space wrap style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }}>
        <Space size={4} wrap>
          {counts.map(([s, n]) => <Tag key={s} color={statusColor(s)}>{TAG_STATUS_LABEL[s]} {n}</Tag>)}
        </Space>
        <Button size="small" icon={<ReloadOutlined />} loading={retrying}
          disabled={unfinished === 0 || retrying || disabled} onClick={onRetry}>
          重试未完成项（{unfinished}）
        </Button>
      </Space>
      <Table size="small" rowKey="key" dataSource={rows}
        pagination={rows.length > 20 ? { pageSize: 20 } : false}
        scroll={{ x: 1000 }}
        columns={[
          {
            title: '状态', dataIndex: 'status', width: 96,
            render: (s: TagResultStatus) => <Tag color={statusColor(s)}>{TAG_STATUS_LABEL[s]}</Tag>,
          },
          { title: 'Region', dataIndex: 'region', width: 110 },
          { title: '名称', dataIndex: 'name', width: 200, render: (n?: string) => n || '-' },
          {
            title: 'ARN', dataIndex: 'arn', width: 300,
            render: (a?: string) => a
              ? <Typography.Text style={{ fontSize: 12, fontFamily: 'SFMono-Regular, Consolas, Menlo, monospace', wordBreak: 'break-all' }}>{a}</Typography.Text>
              : '-',
          },
          ...(showOld ? [{
            title: '旧值', dataIndex: 'oldMapValue', width: 140,
            render: (v?: string | null) => (v === null || v === undefined ? '无' : v),
          }] : []),
          {
            title: 'AWS 实际值', dataIndex: 'actualMapValue', width: 140,
            render: (v?: string | null) => v || '-',
          },
          { title: '说明', dataIndex: 'error', render: (e?: string) => e || '-' },
        ]} />
    </div>
  );
};

export default BedrockTagResults;
