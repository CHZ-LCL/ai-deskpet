import assert from 'node:assert/strict';
import test from 'node:test';
import { looksLikeFailure, parseFailure } from '../../src/debug/stackTrace';

test('解析 Node/TS 堆栈', () => {
  const parsed = parseFailure(
    [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      '    at getUser (E:\\proj\\src\\user.ts:42:18)',
      '    at async handler (E:\\proj\\src\\api\\handler.ts:12:5)',
    ].join('\n'),
  );
  assert.equal(parsed?.language, 'javascript');
  assert.match(parsed?.message ?? '', /Cannot read properties/);
  assert.equal(parsed?.frames[0].file, 'E:\\proj\\src\\user.ts');
  assert.equal(parsed?.frames[0].line, 42);
  assert.equal(parsed?.frames[0].symbol, 'getUser');
});

test('解析 Python Traceback 并取最后一行异常', () => {
  const parsed = parseFailure(
    [
      'Traceback (most recent call last):',
      '  File "app/main.py", line 10, in <module>',
      '    run()',
      '  File "app/service.py", line 22, in run',
      '    total = item.price * qty',
      "AttributeError: 'NoneType' object has no attribute 'price'",
    ].join('\n'),
  );
  assert.equal(parsed?.language, 'python');
  assert.match(parsed?.message ?? '', /AttributeError/);
  // Python traceback 反转后，最深的失败帧在最前面
  assert.deepEqual(
    parsed?.frames.map((frame) => `${frame.file}:${frame.line}`),
    ['app/service.py:22', 'app/main.py:10'],
  );
});

test('解析 Java 堆栈', () => {
  const parsed = parseFailure(
    [
      'java.lang.NullPointerException: Cannot invoke "User.getId()" because "user" is null',
      '    at com.acme.OrderService.create(OrderService.java:42)',
    ].join('\n'),
  );
  assert.equal(parsed?.language, 'java');
  assert.equal(parsed?.frames[0].file, 'OrderService.java');
  assert.equal(parsed?.frames[0].line, 42);
});

test('解析 Go panic', () => {
  const parsed = parseFailure(
    [
      'panic: runtime error: index out of range [5] with length 3',
      '',
      'goroutine 1 [running]:',
      'main.process(...)',
      '\t/app/main.go:42 +0x1d',
    ].join('\n'),
  );
  assert.equal(parsed?.language, 'go');
  assert.equal(parsed?.frames[0].file, '/app/main.go');
  assert.equal(parsed?.frames[0].line, 42);
});

test('解析 Rust panic', () => {
  const parsed = parseFailure(
    ["thread 'main' panicked at src/main.rs:42:5:", 'index out of bounds'].join('\n'),
  );
  assert.equal(parsed?.language, 'rust');
  assert.equal(parsed?.frames[0].file, 'src/main.rs');
  assert.equal(parsed?.frames[0].line, 42);
});

test('看起来像报错的文本能被识别', () => {
  assert.ok(looksLikeFailure("TypeError: x is undefined\n    at a (b.ts:1:2)"));
  assert.ok(looksLikeFailure('npm ERR! code ELIFECYCLE'));
  assert.ok(!looksLikeFailure('这是一段普通说明文字，没有错误。'));
});
