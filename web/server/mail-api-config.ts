import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { MailApiConfig } from './mail-api';

const run = promisify(execFile);

async function readParameter(parameter: string): Promise<string> {
  let config: any = {};
  try { config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config.json'), 'utf8')); } catch {}
  const env: NodeJS.ProcessEnv = { ...process.env, AWS_PAGER: '' };
  // Reuse the platform's configured AWS identity; never copy credentials to CLI arguments.
  if (config.credentials?.accessKeyId && config.credentials?.secretAccessKey) {
    env.AWS_ACCESS_KEY_ID = config.credentials.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = config.credentials.secretAccessKey;
    delete env.AWS_SESSION_TOKEN;
  }
  const { stdout } = await run('aws', ['ssm', 'get-parameter', '--name', parameter, '--with-decryption',
    '--region', process.env.MAIL_API_SSM_REGION || config.region || process.env.AWS_REGION || 'us-east-1',
    '--output', 'json'], { env, timeout: 15_000, maxBuffer: 32_768 });
  return stdout;
}

/** SSM stdout and error diagnostics can contain credentials; expose only a fixed error. */
export async function readMailApiSsmConfig(parameter: string,
  reader: (parameter: string) => Promise<string> = readParameter): Promise<MailApiConfig> {
  try {
    if (!/^\/[A-Za-z0-9_./-]{1,1000}$/.test(parameter)) throw new Error();
    const response = JSON.parse(await reader(parameter));
    if (response.Parameter?.Type !== 'SecureString') throw new Error();
    const value = JSON.parse(response.Parameter.Value);
    if (typeof value?.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.keyId) || typeof value.secret !== 'string'
      || !value.secret.trim() || value.secret.length > 8192) throw new Error();
    return { keyId: value.keyId, secret: value.secret.trim() };
  } catch { throw new Error('邮箱 API 安全配置读取失败，请检查 Parameter Store 和 AWS CLI'); }
}
