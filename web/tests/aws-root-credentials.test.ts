import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STSClient } from '@aws-sdk/client-sts';
import { IAMClient } from '@aws-sdk/client-iam';

const accountId = '123456789012';
const payerRoleArn = 'arn:aws:iam::210987654321:role/tool';

test('root credential operations use isolated payer credentials', async t => {
  const configPath = path.resolve(import.meta.dirname, '../../config.json');
  const readFileSync = fs.readFileSync.bind(fs);
  t.mock.method(fs, 'readFileSync', ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof file === 'string' && path.resolve(file) === configPath) {
      throw Object.assign(new Error('test config intentionally unavailable'), { code: 'ENOENT' });
    }
    return (readFileSync as any)(file, ...args);
  }) as typeof fs.readFileSync);
  const previousPayers = process.env.PAYERS;
  const previousDbPath = process.env.DB_PATH;
  process.env.PAYERS = `test-payer|${payerRoleArn}`;
  process.env.DB_PATH = path.join(os.tmpdir(), `aws-root-credentials-${process.pid}-unused.json`);
  t.after(() => {
    if (previousPayers === undefined) delete process.env.PAYERS;
    else process.env.PAYERS = previousPayers;
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
  });

  const [{ db }, aws] = await Promise.all([import('../server/db'), import('../server/aws-service')]);

  function fixture(ctx: TestContext, policy: string, iamSend: (command: any, options: any) => Promise<any>) {
    ctx.mock.method(db, 'getAccountsCache', () => ({
      accounts: [{ Id: accountId, _payer: 'test-payer' }], cachedAt: '',
    }));
    ctx.mock.method(STSClient.prototype, 'send', (async (command: any, options: any) => {
      assert.ok(options.abortSignal instanceof AbortSignal);
      if (command.constructor.name === 'AssumeRoleCommand') {
        assert.equal(command.input.RoleArn, payerRoleArn);
      } else {
        assert.equal(command.constructor.name, 'AssumeRootCommand');
        assert.equal(command.input.TargetPrincipal, accountId);
        assert.equal(command.input.TaskPolicyArn.arn, policy);
        assert.equal(command.input.DurationSeconds, 900);
      }
      return { Credentials: {
        AccessKeyId: 'test-access', SecretAccessKey: 'test-secret', SessionToken: 'test-token',
      }, $metadata: {} };
    }) as any);
    ctx.mock.method(IAMClient.prototype, 'send', iamSend as any);
    let destroyed = 0;
    ctx.mock.method(IAMClient.prototype, 'destroy', () => { destroyed++; });
    return { get destroyed() { return destroyed; } };
  }

  await t.test('no root MFA device reports a machine code and releases the IAM client', async ctx => {
    const signals: unknown[] = [];
    const state = fixture(ctx, 'arn:aws:iam::aws:policy/root-task/IAMDeleteRootUserCredentials', async (command, options) => {
      assert.equal(command.constructor.name, 'ListMFADevicesCommand');
      signals.push(options?.abortSignal);
      return { MFADevices: [], $metadata: {} };
    });
    await assert.rejects(aws.deleteRootMFA(accountId), (error: any) => {
      assert.equal(error.code, 'ROOT_MFA_NOT_ENABLED');
      assert.equal(error.message, `账户 ${accountId} 的根用户未启用 MFA，无需删除`);
      return true;
    });
    assert.ok(signals[0] instanceof AbortSignal);
    assert.equal(state.destroyed, 1);
  });

  await t.test('partial MFA deactivation returns both removed and failed devices', async ctx => {
    const good = `arn:aws:iam::${accountId}:mfa/good`;
    const bad = `arn:aws:iam::${accountId}:mfa/bad`;
    const commands: { name: string; input: any; signal: unknown }[] = [];
    const state = fixture(ctx, 'arn:aws:iam::aws:policy/root-task/IAMDeleteRootUserCredentials', async (command, options) => {
      commands.push({ name: command.constructor.name, input: command.input, signal: options?.abortSignal });
      if (command.constructor.name === 'ListMFADevicesCommand') {
        assert.deepEqual(command.input, {});
        return { MFADevices: [{ SerialNumber: good }, { SerialNumber: bad }], $metadata: {} };
      }
      if (command.constructor.name === 'DeactivateMFADeviceCommand') {
        assert.equal(command.input.UserName, undefined);
        if (command.input.SerialNumber === bad) throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
        return { $metadata: {} };
      }
      assert.equal(command.constructor.name, 'DeleteVirtualMFADeviceCommand');
      assert.equal(command.input.SerialNumber, good);
      return { $metadata: {} };
    });
    assert.deepEqual(await aws.deleteRootMFA(accountId), {
      accountId, removed: [good], failed: [{ serial: bad, reason: 'AccessDenied: denied' }],
    });
    assert.deepEqual(commands.map(c => c.name), [
      'ListMFADevicesCommand', 'DeactivateMFADeviceCommand', 'DeleteVirtualMFADeviceCommand', 'DeactivateMFADeviceCommand',
    ]);
    assert.ok(commands.every(c => c.signal instanceof AbortSignal));
    assert.equal(state.destroyed, 1);
  });

  await t.test('all MFA deactivations failing still throws and releases the client', async ctx => {
    const serial = `arn:aws:iam::${accountId}:mfa/blocked`;
    const signals: unknown[] = [];
    const state = fixture(ctx, 'arn:aws:iam::aws:policy/root-task/IAMDeleteRootUserCredentials', async (command, options) => {
      signals.push(options?.abortSignal);
      if (command.constructor.name === 'ListMFADevicesCommand') {
        return { MFADevices: [{ SerialNumber: serial }], $metadata: {} };
      }
      assert.equal(command.constructor.name, 'DeactivateMFADeviceCommand');
      throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
    });
    await assert.rejects(aws.deleteRootMFA(accountId), /删除失败：.*AccessDenied: denied/);
    assert.ok(signals.every(signal => signal instanceof AbortSignal));
    assert.equal(state.destroyed, 1);
  });

  await t.test('recovery creates only the root recovery condition', async ctx => {
    const signals: unknown[] = [];
    const state = fixture(ctx, 'arn:aws:iam::aws:policy/root-task/IAMCreateRootUserPassword', async (command, options) => {
      assert.equal(command.constructor.name, 'CreateLoginProfileCommand');
      assert.deepEqual(command.input, {});
      signals.push(options?.abortSignal);
      return { $metadata: {} };
    });
    assert.deepEqual(await aws.recoverRootPassword(accountId), { accountId, ok: true, recoveryAllowed: true });
    assert.ok(signals[0] instanceof AbortSignal);
    assert.equal(state.destroyed, 1);
  });

  await t.test('existing recovery condition keeps its conflict code and releases the client', async ctx => {
    const signals: unknown[] = [];
    const state = fixture(ctx, 'arn:aws:iam::aws:policy/root-task/IAMCreateRootUserPassword', async (command, options) => {
      assert.equal(command.constructor.name, 'CreateLoginProfileCommand');
      assert.deepEqual(command.input, {});
      signals.push(options?.abortSignal);
      throw Object.assign(new Error('already exists'), { name: 'EntityAlreadyExistsException' });
    });
    await assert.rejects(aws.recoverRootPassword(accountId), (error: any) => {
      assert.equal(error.code, 'ROOT_PASSWORD_ALREADY_EXISTS');
      assert.match(error.message, /已具备 Root 密码恢复条件/);
      return true;
    });
    assert.ok(signals[0] instanceof AbortSignal);
    assert.equal(state.destroyed, 1);
  });
});
