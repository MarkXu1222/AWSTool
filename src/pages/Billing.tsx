import React, { useState } from 'react';
import { Card, Table, Button, DatePicker, Space, message, Statistic, Row, Col, Tag, Input, Dropdown } from 'antd';
import { DollarOutlined, ReloadOutlined, SearchOutlined, DownloadOutlined, FileExcelOutlined, FileTextOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { CostResult } from '../types/aws';
import { exportToCSV, exportToJSON } from '../utils/export';

const { RangePicker } = DatePicker;

const BillingPage: React.FC = () => {
  const [costData, setCostData] = useState<CostResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([
    dayjs().subtract(1, 'month').startOf('month'),
    dayjs().endOf('month'),
  ]);
  const [totalCost, setTotalCost] = useState<number>(0);
  const [searchText, setSearchText] = useState('');

  const fetchCosts = async () => {
    setLoading(true);
    try {
      const startDate = dateRange[0].format('YYYY-MM-DD');
      const endDate = dateRange[1].format('YYYY-MM-DD');

      const result = await window.awsAPI.getCostByAccount(startDate, endDate);
      if (result.success && result.data) {
        setCostData(result.data);
        let total = 0;
        result.data.forEach((period) => {
          period.Groups?.forEach((group) => {
            total += parseFloat(group.Metrics.UnblendedCost.Amount || '0');
          });
        });
        setTotalCost(total);
      } else {
        message.error(result.error || '获取账单失败');
      }
    } catch (err: any) { message.error(err.message); }
    finally { setLoading(false); }
  };

  const tableData = costData.flatMap((period) =>
    (period.Groups || []).map((group) => ({
      key: `${period.TimePeriod.Start}-${group.Keys[0]}`,
      period: `${period.TimePeriod.Start} ~ ${period.TimePeriod.End}`,
      accountId: group.Keys[0],
      cost: parseFloat(group.Metrics.UnblendedCost.Amount || '0'),
      unit: group.Metrics.UnblendedCost.Unit || 'USD',
    }))
  ).sort((a, b) => b.cost - a.cost);

  const filteredData = tableData.filter(d =>
    !searchText || d.accountId?.includes(searchText) || d.period?.includes(searchText)
  );

  const handleExportCSV = () => {
    exportToCSV(
      filteredData.map(d => ({ '账期': d.period, '账户ID': d.accountId, '费用(USD)': d.cost.toFixed(4), '占比': totalCost > 0 ? ((d.cost / totalCost) * 100).toFixed(1) + '%' : '0%' })),
      'billing_by_account'
    );
    message.success('已导出 CSV');
  };

  const handleExportJSON = () => {
    exportToJSON({ dateRange: [dateRange[0].format('YYYY-MM-DD'), dateRange[1].format('YYYY-MM-DD')], totalCost, data: filteredData }, 'billing_by_account');
    message.success('已导出 JSON');
  };

  const columns = [
    { title: '账期', dataIndex: 'period', key: 'period' },
    {
      title: '账户 ID', dataIndex: 'accountId', key: 'accountId',
      render: (id: string) => <code style={{ color: 'var(--status-warning, #ff9500)' }}>{id}</code>,
    },
    {
      title: '费用', dataIndex: 'cost', key: 'cost',
      sorter: (a: any, b: any) => a.cost - b.cost,
      render: (cost: number, record: any) => (
        <span style={{ fontWeight: 600, color: cost > 100 ? '#ff4d4f' : cost > 10 ? '#faad14' : '#52c41a' }}>
          ${cost.toFixed(2)} {record.unit}
        </span>
      ),
    },
    {
      title: '占比', key: 'percentage',
      render: (_: any, record: any) => {
        const pct = totalCost > 0 ? (record.cost / totalCost) * 100 : 0;
        return <Tag color="blue">{pct.toFixed(1)}%</Tag>;
      },
    },
  ];

  return (
    <div className="page-container">
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card >
            <Statistic title="总费用" value={totalCost} precision={2} prefix={<DollarOutlined />} suffix="USD"
              valueStyle={{ color: 'var(--status-warning, #ff9500)', fontSize: 28 }} />
          </Card>
        </Col>
        <Col span={8}>
          <Card >
            <Statistic title="账户数" value={new Set(tableData.map((d) => d.accountId)).size} valueStyle={{ color: '#1890ff' }} />
          </Card>
        </Col>
        <Col span={8}>
          <Card >
            <Statistic title="日均费用" value={totalCost / Math.max(dateRange[1].diff(dateRange[0], 'day'), 1)}
              precision={2} prefix={<DollarOutlined />} suffix="USD" valueStyle={{ color: '#52c41a' }} />
          </Card>
        </Col>
      </Row>

      <Card
        title={<span style={{ fontSize: 18, fontWeight: 600 }}>💰 账单详情</span>}
        extra={
          <Dropdown menu={{
            items: [
              { key: 'csv', label: '导出 CSV', icon: <FileExcelOutlined />, onClick: handleExportCSV },
              { key: 'json', label: '导出 JSON', icon: <FileTextOutlined />, onClick: handleExportJSON },
            ]
          }}>
            <Button icon={<DownloadOutlined />}>导出</Button>
          </Dropdown>
        }
        
      >
        <Space style={{ marginBottom: 16 }}>
          <RangePicker value={dateRange}
            onChange={(dates) => { if (dates && dates[0] && dates[1]) setDateRange([dates[0], dates[1]]); }}
            picker="month" />
          <Button icon={<ReloadOutlined />} onClick={fetchCosts} loading={loading} type="primary">查询</Button>
        </Space>

        <Input placeholder="搜索账户 ID..." prefix={<SearchOutlined />} value={searchText}
          onChange={(e) => setSearchText(e.target.value)} allowClear style={{ marginBottom: 12, maxWidth: 300 }} />

        <Table columns={columns} dataSource={filteredData} loading={loading}
          size="middle" pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={2}><strong>总计</strong></Table.Summary.Cell>
              <Table.Summary.Cell index={2}>
                <strong style={{ color: 'var(--status-warning, #ff9500)', fontSize: 16 }}>${totalCost.toFixed(2)} USD</strong>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={3}><Tag color="green">100%</Tag></Table.Summary.Cell>
            </Table.Summary.Row>
          )} />
      </Card>
    </div>
  );
};

export default BillingPage;
