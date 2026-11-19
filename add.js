'use strict';
const { resolveTargets, errMsg, sleep } = require('../src/utils');

module.exports = {
  names: ['add'],
  category: 'members',
  hint: '+ رابط حساب',
  desc: 'إضافة عضو للمجموعة',
  groupOnly: true,
  async run(ctx) {
    const { ids, failed } = await resolveTargets(ctx, { reply: false });
    if (!ids.length) {
      return void (await ctx.send(failed.length ? `⚠️ تعذر استخراج الايدي من: ${failed.join(' , ')}` : '✏️ الاستخدام: add رابط الحساب'));
    }
    for (const id of ids) {
      try {
        await ctx.call('addUserToGroup', id, ctx.threadID);
        await ctx.send(`✅ تمت إضافة ${id}`);
      } catch (e) {
        await ctx.send(`❌ تعذرت إضافة ${id}: ${errMsg(e)}`);
      }
      await sleep(700);
    }
  },
};
