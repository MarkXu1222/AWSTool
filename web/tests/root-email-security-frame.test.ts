import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { AwsRootEmailSession, classifyRootEmailBrowserError, isRootEmailSecurityFrameUrl,
  readRootEmailSecurityChallengeState, readRootRecoveryRetryForm } from '../server/root-email-browser';
import { RootEmailError } from '../server/root-email-core';

test('security frame trust accepts only HTTPS AWS regional challenge hosts', () => {
  assert.equal(isRootEmailSecurityFrameUrl('https://cdn.us-west-2.threat-mitigation.aws.amazon.com/challenge'), true);
  for (const url of ['http://cdn.us-west-2.threat-mitigation.aws.amazon.com/',
    'https://cdn.us-west-2.threat-mitigation.aws.amazon.com.evil.test/',
    'https://evil.test/cdn.us-west-2.threat-mitigation.aws.amazon.com',
    'https://user@cdn.us-west-2.threat-mitigation.aws.amazon.com/',
    'https://cdn.us-west-2.threat-mitigation.aws.amazon.com:8443/', 'about:blank']) {
    assert.equal(isRootEmailSecurityFrameUrl(url), false, url);
  }
  assert.equal(readRootEmailSecurityChallengeState.toString().includes('__name'), false);
});

test('security frame is rejected after detachment, origin change or unexpected nesting', () => {
  const session = new AwsRootEmailSession(new AbortController().signal, () => {});
  const main = {};
  (session as any).page = { url: () => 'https://us-west-2.signin.aws.amazon.com/signin', mainFrame: () => main };
  const frame = { detached: false, parentFrame: () => main,
    url: () => 'https://cdn.us-west-2.threat-mitigation.aws.amazon.com/challenge' };
  (session as any).securityFrame = frame;
  assert.equal((session as any).checkedCaptchaContext(), frame);
  frame.detached = true;
  assert.throws(() => (session as any).checkedCaptchaContext(), RootEmailError);
  frame.detached = false;
  frame.url = () => 'https://evil.test/';
  assert.throws(() => (session as any).checkedCaptchaContext(), RootEmailError);
  frame.url = () => 'https://cdn.us-west-2.threat-mitigation.aws.amazon.com/challenge';
  frame.parentFrame = () => ({});
  assert.throws(() => (session as any).checkedCaptchaContext(), RootEmailError);
});

test('DOM read deadlines are classified as timeout instead of generic browser_error', async () => {
  const session = new AwsRootEmailSession(new AbortController().signal, () => {});
  await assert.rejects((session as any).boundedEvaluate(new Promise(() => {}), Date.now() + 5), error => {
    assert.equal(classifyRootEmailBrowserError(error, 'wait_entry').category, 'timeout');
    return true;
  });
});

const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(p => p && fs.existsSync(p));

test('real Chrome handles the isolated challenge, refresh, rejection and transition to recovery',
  { skip: !chrome, timeout: 45_000 }, async () => {
    const { default: puppeteer } = await import('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true,
      args: ['--no-first-run', '--disable-dev-shm-usage'] });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5_000);
      await page.setRequestInterception(true);
      const svg = (color: string) => `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="70"><rect width="200" height="70" fill="${color}"/></svg>`)}`;
      const parent = `<!doctype html><html><body>Making sure its you
        <button id="verify">Verify</button><script>
        window.verifies=0; window.recoverySubmits=0;
        document.querySelector('#verify').onclick=()=>{window.verifies++; const dialog=document.createElement('div');
          dialog.setAttribute('role','dialog'); dialog.innerHTML='<iframe id="core-container" width="650" height="400" src="https://cdn.us-west-2.threat-mitigation.aws.amazon.com/challenge"></iframe>';document.body.append(dialog);};
        window.addEventListener('message', event=>{if(event.data!=='verified')return;
          document.body.innerHTML='owner@example.test <button id="forgot">Forgot password?</button>';
          document.querySelector('#forgot').onclick=()=>{document.body.innerHTML=
            '<img id="captcha_image" src="${svg('green')}"><label>Type the characters as shown above<input></label><button id="send">I’m not a robot</button>';
            document.querySelector('#send').onclick=()=>{window.recoverySubmits++;document.body.innerText='Password email sent';};};});
        </script></body></html>`;
      const challenge = `<!doctype html><html><body>
        <img alt="captcha" src="${svg('red')}"><label>Type the characters as shown above
        <input type="text" placeholder="Verification answer"></label><p id="error"></p>
        <button id="refresh"><img alt="Display new security image." src="${svg('gray')}"></button>
        <button type="submit">Submit</button><script>window.refreshes=0;window.submits=0;
        document.querySelector('#refresh').onclick=()=>{window.refreshes++;document.querySelector('img[alt=captcha]').src='${svg('blue')}';document.querySelector('#error').textContent='';};
        document.querySelector('button[type=submit]').onclick=()=>{window.submits++;
          if(document.querySelector('input').value==='abc123')parent.postMessage('verified','https://us-west-2.signin.aws.amazon.com');
          else document.querySelector('#error').textContent='Incorrect verification answer';};</script>
        </body></html>`;
      // Every HTTP request is intercepted; this test never contacts AWS or sends email.
      page.on('request', request => {
        if (request.url().startsWith('data:')) { void request.continue(); return; }
        const html = request.url() === 'https://us-west-2.signin.aws.amazon.com/signin' ? parent
          : request.url() === 'https://cdn.us-west-2.threat-mitigation.aws.amazon.com/challenge' ? challenge : '';
        void request.respond({ status: html ? 200 : 404, contentType: 'text/html; charset=utf-8', body: html });
      });
      await page.goto('https://us-west-2.signin.aws.amazon.com/signin');
      const session = new AwsRootEmailSession(new AbortController().signal, () => {});
      (session as any).page = page;
      (session as any).expectedEmail = 'owner@example.test';
      (session as any).captchaPurpose = 'identity';
      assert.equal(await (session as any).waitForEntry(), 'identity');
      assert.equal(await page.evaluate('window.verifies'), 1);
      const frame = (session as any).securityFrame;
      assert.equal(await frame.evaluate(readRootEmailSecurityChallengeState), 'ready');
      await frame.evaluate(`document.body.insertAdjacentHTML('beforeend', '<button id="duplicate" type="submit">Submit</button>')`);
      assert.equal(await frame.evaluate(readRootEmailSecurityChallengeState), 'unsupported');
      await assert.rejects(session.submit('abc123'), RootEmailError);
      assert.equal(await frame.evaluate('window.submits'), 0);
      await frame.evaluate(`document.querySelector('#duplicate').remove()`);
      const first = await (session as any).capture();
      assert.ok(first.image.length > 0);
      assert.equal(await session.submit('wrong1'), 'invalid');
      assert.equal(await frame.evaluate('window.submits'), 1);
      await session.refresh(first.imageId);
      assert.equal(await frame.evaluate('window.refreshes'), 1);
      assert.notEqual((await (session as any).capture()).imageId, first.imageId);
      // Duplicate or hidden controls must never change the concrete submit target.
      await frame.evaluate(`document.body.insertAdjacentHTML('afterbegin', '<button type="submit" hidden>Submit</button>')`);
      assert.equal(await frame.evaluate(readRootEmailSecurityChallengeState), 'ready');
      assert.equal(await session.submit('abc123'), 'next_captcha');
      assert.equal(session.isRecoveryCaptcha(), true);
      assert.equal((session as any).securityFrame, undefined);
      assert.equal(await page.evaluate('window.recoverySubmits'), 0);
      assert.equal(readRootRecoveryRetryForm.toString().includes('__name'), false);
      assert.equal(await session.inspectRecoverySubmission(), 'ready');
      await page.evaluate(`document.querySelector('#send').disabled=true`);
      assert.equal(await session.inspectRecoverySubmission(), 'unavailable');
      await page.evaluate(`document.querySelector('#send').disabled=false;
        document.body.insertAdjacentHTML('beforeend', '<button id="second-send">I’m not a robot</button>')`);
      assert.equal(await session.inspectRecoverySubmission(), 'unavailable');
      await page.evaluate(`document.querySelector('#second-send').remove()`);
      const inFlight = {};
      (session as any).pendingRequests.add(inFlight);
      assert.equal(await session.inspectRecoverySubmission(), 'unavailable');
      (session as any).pendingRequests.delete(inFlight);
      assert.equal(await session.submit('abc123'), 'sent');
      assert.equal(await session.inspectRecoverySubmission(), 'sent');
      assert.equal(await page.evaluate('window.recoverySubmits'), 1);
    } finally { await browser.close(); }
  });
