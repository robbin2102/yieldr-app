import {test} from 'node:test';
import assert from 'node:assert/strict';
import {holdingQuantity,holdingReturn} from '../../lib/edge/holding-display';
test('balances truncate without rounding up or losing large integer precision',()=>{
 assert.equal(holdingQuantity('1529226.94467'),'1,529,226.94');
 assert.equal(holdingQuantity('1998'),'1,998');
 assert.equal(holdingQuantity('0.028839'),'0.0288');
 assert.equal(holdingQuantity('0.0000001'),'<0.0001');
 assert.equal(holdingQuantity('9007199254740993.999'),'9,007,199,254,740,993.99');
 assert.equal(holdingQuantity(null),'—');
});
test('unrealized returns require a finite positive entry cost',()=>{
 assert.deepEqual(holdingReturn('125','100'),{dollars:25,percent:25});
 assert.deepEqual(holdingReturn('0','100'),{dollars:-100,percent:-100});
 for(const basis of [null,'0','','NaN','-10'])assert.equal(holdingReturn('125',basis),null);
 assert.equal(holdingReturn(null,'100'),null);
});
