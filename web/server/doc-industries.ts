/**
 * 行业模板：非 yanhuang payer 的提额文档用「自家公司名 + 手选行业类型」生成。
 *
 * 为什么不能复用 COMPANY_PROFILES：那是 yanhuang 各家公司的真实背景（从历史 SOW 总结），
 * 套到别的组织上等于拿别家公司的资料去提额。这里的文案全部以传入的公司名为主语，
 * 不出现任何具体客户名；也没有公司专属架构图，由 doc-generator 画通用架构图。
 */
import type { CompanyProfile } from './doc-templates';

export interface IndustryTemplate {
  key: string;
  label: string;              // 下拉显示（中文）
  industry: string;           // 文档里的行业（英文）
  sourceCloud: string;
  /** 以下文案中的 {C} 会被替换成（已转义的）公司名 */
  summary: string;
  migrationBackground: string;
  coreBusiness: string;
  technicalArchitecture: string;
  resourceComponents: CompanyProfile['resourceComponents'];
}

export const INDUSTRY_TEMPLATES: IndustryTemplate[] = [
  {
    key: 'logistics',
    label: '物流 / 快递 / 供应链',
    industry: 'Logistics / Supply Chain',
    sourceCloud: 'On-premise IDC',
    summary: `{C} is a technology-driven logistics and supply chain company providing parcel delivery, freight forwarding, warehousing and last-mile fulfilment services for merchants and enterprises across Southeast Asia. Its digital platform connects shippers, carriers, warehouses and end customers, covering order intake, shipment booking, route planning, real-time tracking, proof of delivery and billing. Shopping festivals and year-end peaks drive sharp, short-term spikes in shipment volume, API calls and tracking queries.`,
    migrationBackground: `{C}'s core logistics systems currently run in a self-managed data center with limited elastic capacity. To support business growth and absorb seasonal peaks without over-provisioning hardware, {C} is migrating its shipment management, tracking and routing services to AWS. During the cut-over both environments run in parallel so that live shipments are never interrupted, which temporarily increases the compute demand on AWS.`,
    coreBusiness: `Shipment booking and order management, real-time parcel tracking, route optimization and dispatch, warehouse management (WMS), carrier and merchant API integration, electronic proof of delivery, and billing / reconciliation.`,
    technicalArchitecture: `A multi-AZ VPC with public subnets for load balancers and NAT gateways, private subnets for containerized microservices on EC2 Auto Scaling groups, and isolated database subnets for Amazon RDS with a Multi-AZ standby. Tracking events flow through a message queue into stream processors; Amazon S3 stores shipping labels, documents and proof-of-delivery images.`,
    resourceComponents: [
      { name: 'Shipment & Order Services', useType: 'Core services', purpose: 'Booking, order intake and shipment lifecycle management.', weight: 0.24 },
      { name: 'Tracking & Event Processing', useType: 'Real-time processing', purpose: 'Ingest scan events and serve real-time tracking queries.', weight: 0.20 },
      { name: 'Route Optimization & Dispatch', useType: 'Compute-intensive', purpose: 'Route planning, driver dispatch and ETA calculation.', weight: 0.18 },
      { name: 'Merchant / Carrier API Gateway', useType: 'Integration', purpose: 'Partner API integration and webhook delivery.', weight: 0.14 },
      { name: 'Data & Reporting', useType: 'BI/ETL workloads', purpose: 'Operational dashboards, billing and reconciliation.', weight: 0.12 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Parallel verification during migration.', weight: 0.12 },
    ],
  },
  {
    key: 'ecommerce',
    label: '电商 / 零售',
    industry: 'E-commerce / Online Retail',
    sourceCloud: 'Alibaba Cloud',
    summary: `{C} operates an online retail and e-commerce platform serving consumers and merchants through web, mobile app and social commerce channels. The platform covers product catalog, search and recommendation, cart and checkout, payment, order fulfilment, customer service and marketing campaigns. Flash sales and seasonal promotions generate traffic peaks many times higher than the daily baseline, which requires elastic and highly available infrastructure.`,
    migrationBackground: `{C}'s platform currently runs on another cloud provider. To improve availability, serve regional customers with lower latency and adopt AWS managed services, {C} is migrating its storefront, order and payment systems to AWS. Both environments run in parallel during the transition to guarantee uninterrupted sales.`,
    coreBusiness: `Product catalog and search, personalized recommendation, cart and checkout, payment integration, order and inventory management, promotion engine, customer service, and sales analytics.`,
    technicalArchitecture: `Stateless web and API tiers run on EC2 Auto Scaling groups behind Application Load Balancers across two Availability Zones. Amazon RDS (Multi-AZ) stores transactional data, an in-memory cache absorbs read traffic, and Amazon S3 with Amazon CloudFront serves product images and static assets.`,
    resourceComponents: [
      { name: 'Storefront Web & API Tier', useType: 'Core services', purpose: 'Serve web/app traffic and product browsing.', weight: 0.26 },
      { name: 'Order & Payment Services', useType: 'Transaction processing', purpose: 'Checkout, payment callbacks and order lifecycle.', weight: 0.20 },
      { name: 'Search & Recommendation', useType: 'Compute-intensive', purpose: 'Search indexing and recommendation models.', weight: 0.18 },
      { name: 'Inventory & Fulfilment', useType: 'Core platform', purpose: 'Stock synchronization and warehouse integration.', weight: 0.14 },
      { name: 'Analytics & Campaigns', useType: 'BI/ETL workloads', purpose: 'Sales reporting and promotion targeting.', weight: 0.12 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Pre-release and load testing before campaigns.', weight: 0.10 },
    ],
  },
  {
    key: 'gaming',
    label: '游戏',
    industry: 'Online Gaming',
    sourceCloud: 'On-premise IDC',
    summary: `{C} develops and operates online games for mobile and PC players. Its live services include game servers, matchmaking, player accounts, in-game store and payments, leaderboards, chat and anti-cheat. Game launches, version updates and in-game events cause sudden spikes in concurrent players, so game server capacity must be provisioned in advance to avoid queueing, lag and player churn.`,
    migrationBackground: `{C} currently hosts its game servers in a traditional data center. To support upcoming title launches and expand into new regions with low latency, {C} is moving its game backend and supporting services to AWS, keeping the existing environment online until every region has been switched over.`,
    coreBusiness: `Real-time game servers, matchmaking, player account and profile services, in-game store and payment, leaderboards and social features, telemetry and anti-cheat analytics.`,
    technicalArchitecture: `Dedicated game server fleets run on EC2 in private subnets across two Availability Zones, with load balancers fronting login and lobby services. Player data is stored in Amazon RDS (Multi-AZ) and an in-memory cache, and gameplay telemetry is streamed to Amazon S3 for analytics.`,
    resourceComponents: [
      { name: 'Game Server Fleet', useType: 'Core services', purpose: 'Host real-time game sessions for concurrent players.', weight: 0.34 },
      { name: 'Matchmaking & Lobby', useType: 'Core platform', purpose: 'Player matching, room allocation and lobby services.', weight: 0.16 },
      { name: 'Account, Store & Payment', useType: 'Transaction processing', purpose: 'Login, inventory, purchases and payment callbacks.', weight: 0.14 },
      { name: 'Telemetry & Anti-cheat', useType: 'Data Ops', purpose: 'Gameplay telemetry ingestion and cheat detection.', weight: 0.14 },
      { name: 'Ops & Monitoring', useType: 'Operations', purpose: 'Deployment pipelines, monitoring and log processing.', weight: 0.10 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Build verification and pre-launch stress testing.', weight: 0.12 },
    ],
  },
  {
    key: 'fintech',
    label: '金融科技 / 支付',
    industry: 'Fintech / Digital Payments',
    sourceCloud: 'On-premise IDC',
    summary: `{C} is a financial technology company offering digital payment, e-wallet and merchant acquiring services. Its platform processes payment authorization, fund transfers, settlement, reconciliation and risk control for consumers and merchants, with strict requirements on availability, latency, data integrity and regulatory compliance. Transaction volume rises sharply at month-end, payday and during promotional campaigns.`,
    migrationBackground: `{C}'s transaction platform currently runs in a private data center. To improve resilience, shorten time-to-market for new products and meet growing transaction volume, {C} is migrating its payment, ledger and risk services to AWS. A parallel-run period with full reconciliation between both environments is required before the final cut-over.`,
    coreBusiness: `Payment gateway and authorization, e-wallet and fund transfer, merchant onboarding (KYC/KYB), settlement and reconciliation, real-time fraud and risk scoring, and regulatory reporting.`,
    technicalArchitecture: `Workloads are isolated in private subnets across multiple Availability Zones with no direct internet exposure; ingress passes through load balancers and a web application firewall. Ledger and transaction data are stored in Amazon RDS (Multi-AZ) with encryption at rest via AWS KMS, and audit logs are retained in Amazon S3.`,
    resourceComponents: [
      { name: 'Payment Gateway & Authorization', useType: 'Core services', purpose: 'Low-latency payment authorization and routing.', weight: 0.24 },
      { name: 'Ledger & Settlement', useType: 'Transaction processing', purpose: 'Double-entry ledger, settlement and reconciliation.', weight: 0.20 },
      { name: 'Risk & Fraud Engine', useType: 'Compute-intensive', purpose: 'Real-time risk scoring and fraud detection.', weight: 0.18 },
      { name: 'Merchant & KYC Services', useType: 'Core platform', purpose: 'Merchant onboarding and identity verification.', weight: 0.12 },
      { name: 'Reporting & Compliance', useType: 'BI/ETL workloads', purpose: 'Regulatory reporting and audit data processing.', weight: 0.12 },
      { name: 'DR & Staging Environment', useType: 'QA/DR', purpose: 'Parallel-run verification and disaster recovery drills.', weight: 0.14 },
    ],
  },
  {
    key: 'ai',
    label: 'AI / 机器学习 / 数据平台',
    industry: 'AI / Machine Learning',
    sourceCloud: 'Cloud-based platform',
    summary: `{C} builds AI and data products for enterprise customers, including large-language-model applications, computer vision, intelligent document processing and predictive analytics. Its platform covers data ingestion and labeling, model training and fine-tuning, model evaluation, and low-latency online inference served through APIs. Training jobs and customer onboarding create bursty, compute-heavy demand that must be scheduled reliably.`,
    migrationBackground: `{C}'s training and inference workloads are currently spread across rented GPU servers and another cloud, which limits capacity and makes scheduling unpredictable. {C} is consolidating its data pipelines, training clusters and inference services on AWS to obtain stable accelerator capacity and a unified security and data governance model.`,
    coreBusiness: `Data ingestion and preprocessing, data labeling, distributed model training and fine-tuning, model evaluation and registry, real-time and batch inference APIs, and usage analytics.`,
    technicalArchitecture: `Training clusters run on accelerated EC2 instances in private subnets with high-throughput access to datasets in Amazon S3. Inference services run on auto-scaling instance groups behind load balancers across two Availability Zones, while metadata and job state are stored in Amazon RDS.`,
    resourceComponents: [
      { name: 'Model Training Cluster', useType: 'Compute-intensive', purpose: 'Distributed training and fine-tuning jobs.', weight: 0.30 },
      { name: 'Online Inference Services', useType: 'Core services', purpose: 'Low-latency model serving behind APIs.', weight: 0.24 },
      { name: 'Data Pipeline & Preprocessing', useType: 'Data Ops', purpose: 'Ingestion, cleaning and feature generation.', weight: 0.16 },
      { name: 'Batch Inference & Evaluation', useType: 'Batch workloads', purpose: 'Offline scoring and model evaluation runs.', weight: 0.12 },
      { name: 'Platform & API Layer', useType: 'Integration', purpose: 'Customer API gateway, auth and metering.', weight: 0.08 },
      { name: 'Development & Experimentation', useType: 'QA/test', purpose: 'Notebooks, experiments and staging.', weight: 0.10 },
    ],
  },
  {
    key: 'saas',
    label: 'SaaS / 企业软件',
    industry: 'SaaS / Enterprise Software',
    sourceCloud: 'Alibaba Cloud',
    summary: `{C} provides cloud-based business software to small and medium-sized enterprises, covering workflow automation, CRM, HR and finance modules delivered through web and mobile clients. As a multi-tenant SaaS provider, {C} must keep every tenant isolated, highly available and responsive while onboarding new customers continuously, so compute capacity grows with the number of tenants and their usage.`,
    migrationBackground: `{C}'s SaaS platform currently runs on another cloud provider. To serve customers in more regions, meet enterprise security requirements and reduce operational overhead, {C} is migrating its application tier, background workers and databases to AWS, running both environments in parallel while tenants are moved in batches.`,
    coreBusiness: `Multi-tenant web application, REST/GraphQL APIs, background job processing, reporting and dashboards, file storage and document generation, notifications, and third-party integrations.`,
    technicalArchitecture: `Containerized application services run on EC2 Auto Scaling groups in private subnets behind Application Load Balancers across two Availability Zones. Tenant data is stored in Amazon RDS (Multi-AZ), background jobs are coordinated through a message queue, and Amazon S3 stores uploaded files and generated reports.`,
    resourceComponents: [
      { name: 'Web Application Tier', useType: 'Core services', purpose: 'Serve tenant web and mobile traffic.', weight: 0.26 },
      { name: 'API Services', useType: 'Core platform', purpose: 'Public and internal APIs for integrations.', weight: 0.18 },
      { name: 'Background Workers', useType: 'Batch workloads', purpose: 'Scheduled jobs, imports/exports and notifications.', weight: 0.18 },
      { name: 'Reporting & Search', useType: 'BI/ETL workloads', purpose: 'Tenant dashboards, reports and full-text search.', weight: 0.14 },
      { name: 'Integration Layer', useType: 'Integration', purpose: 'Third-party connectors and webhooks.', weight: 0.12 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Tenant migration rehearsal and release testing.', weight: 0.12 },
    ],
  },
  {
    key: 'media',
    label: '视频 / 直播 / 内容平台',
    industry: 'Media / Video Streaming',
    sourceCloud: 'On-premise IDC',
    summary: `{C} operates a digital media platform offering video-on-demand, live streaming and short-video content to audiences on mobile, web and smart TV. The platform handles content upload, transcoding, packaging, delivery, recommendation and monetization. Live events and popular releases produce sharp concurrency peaks that require large amounts of transcoding and streaming capacity at short notice.`,
    migrationBackground: `{C} currently runs its transcoding and origin servers in a data center with fixed capacity, which cannot absorb event-driven peaks. {C} is migrating its media processing pipeline, origin services and content management system to AWS to scale elastically and reach audiences in more regions.`,
    coreBusiness: `Content ingest and transcoding, live stream processing, origin and content delivery, user accounts and subscriptions, recommendation, advertising, and viewing analytics.`,
    technicalArchitecture: `Transcoding workers run on auto-scaling EC2 fleets in private subnets, reading and writing media in Amazon S3. Origin servers sit behind load balancers and are fronted by Amazon CloudFront. User and subscription data are stored in Amazon RDS (Multi-AZ) across two Availability Zones.`,
    resourceComponents: [
      { name: 'Transcoding Workers', useType: 'Compute-intensive', purpose: 'Transcode and package video into multiple bitrates.', weight: 0.30 },
      { name: 'Live Stream Processing', useType: 'Real-time processing', purpose: 'Ingest and process live streams.', weight: 0.20 },
      { name: 'Origin & API Services', useType: 'Core services', purpose: 'Serve manifests, segments and app APIs.', weight: 0.18 },
      { name: 'Recommendation & Ads', useType: 'Core platform', purpose: 'Personalized feeds and ad decisioning.', weight: 0.12 },
      { name: 'Analytics Pipeline', useType: 'BI/ETL workloads', purpose: 'Playback quality and audience analytics.', weight: 0.10 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Player and pipeline release testing.', weight: 0.10 },
    ],
  },
  {
    key: 'general',
    label: '通用互联网 / 其他',
    industry: 'Internet Services',
    sourceCloud: 'On-premise IDC',
    summary: `{C} is a technology company that builds and operates internet services for business and consumer customers. Its platform consists of customer-facing web and mobile applications, backend APIs, data processing pipelines and internal operation systems. Continued user growth and new product launches require the platform to scale reliably while maintaining high availability.`,
    migrationBackground: `{C}'s workloads currently run in a self-managed environment. To gain elastic capacity, improve availability and accelerate product delivery, {C} is migrating its application and data services to AWS, running both environments in parallel during the transition to avoid service interruption.`,
    coreBusiness: `Customer-facing web and mobile applications, backend APIs, data processing and analytics, user and account management, and internal operation systems.`,
    technicalArchitecture: `A multi-AZ VPC with public subnets for load balancers and NAT gateways and private subnets for application servers on EC2 Auto Scaling groups. Databases run on Amazon RDS (Multi-AZ), and Amazon S3 stores static assets, backups and logs.`,
    resourceComponents: [
      { name: 'Application Services', useType: 'Core services', purpose: 'Customer-facing web and mobile backends.', weight: 0.28 },
      { name: 'API & Integration Layer', useType: 'Integration', purpose: 'Public APIs and partner integrations.', weight: 0.18 },
      { name: 'Data Processing', useType: 'BI/ETL workloads', purpose: 'Batch and streaming data processing.', weight: 0.18 },
      { name: 'Background Jobs', useType: 'Batch workloads', purpose: 'Scheduled tasks and asynchronous processing.', weight: 0.14 },
      { name: 'Ops & Monitoring', useType: 'Operations', purpose: 'CI/CD, monitoring and log processing.', weight: 0.10 },
      { name: 'Development & Staging', useType: 'QA/test', purpose: 'Parallel verification during migration.', weight: 0.12 },
    ],
  },
];

export const DEFAULT_INDUSTRY = 'general';

export function getIndustry(key?: string): IndustryTemplate | null {
  if (!key) return null;
  return INDUSTRY_TEMPLATES.find(t => t.key === key) || null;
}

/** 公司名清洗：控制字符换空格、压缩空白、去首尾空白，最长 120 */
export function normalizeCompanyName(name?: string): string {
  return String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]);
}

/**
 * 公司名 + 行业 → 文档用的 CompanyProfile。
 * 文案里的 {C} 替换成**已转义**的公司名（buildHTML 直接插入 profile 文案）；
 * archImage 为空 → doc-generator 使用通用架构图。
 */
export function buildIndustryProfile(companyName: string, industryKey: string): CompanyProfile {
  const name = normalizeCompanyName(companyName);
  if (!name) throw new Error('公司名不能为空');
  const t = getIndustry(industryKey);
  if (!t) throw new Error(`未知的行业类型: ${industryKey}`);
  const fill = (s: string) => s.split('{C}').join(escapeHtml(name));
  return {
    key: `industry-${t.key}`,
    displayName: name,
    industry: t.industry,
    summary: fill(t.summary),
    migrationBackground: fill(t.migrationBackground),
    coreBusiness: fill(t.coreBusiness),
    technicalArchitecture: fill(t.technicalArchitecture),
    sourceCloud: t.sourceCloud,
    archImage: '',
    resourceComponents: t.resourceComponents,
  };
}

/** 是否 yanhuang 系 payer（含 "yan-huang21" 这种写法）。这类继续走 COMPANY_PROFILES 专属模板 */
export function isYanhuangPayer(payer?: string): boolean {
  return /^yan-?huang/i.test(String(payer || '').trim());
}
