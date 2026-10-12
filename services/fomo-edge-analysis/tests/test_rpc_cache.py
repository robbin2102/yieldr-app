from bson import BSON
from rpc_cache import encode_rpc, decode_rpc

def test_solana_unsigned_rent_epoch_roundtrips_through_bson():
    response={'context':{'slot':123},'value':{'rentEpoch':2**64-1,'lamports':2039280,'data':['AA==','base64'],'executable':False}}
    assert decode_rpc(BSON(BSON.encode(encode_rpc(response))).decode())==response

def test_nested_large_integers_preserve_exact_values_and_json_types():
    response={'rows':[2**63-1,2**63,2**128,-2**90,None,True,'18446744073709551615',{'number':2**64-1}]}
    decoded=decode_rpc(BSON(BSON.encode(encode_rpc(response))).decode())
    assert decoded==response
    assert isinstance(decoded['rows'][1],int) and isinstance(decoded['rows'][5],bool)

def test_solana_extraction_metadata_cache_preserves_unsigned_values():
    import mongomock
    from types import SimpleNamespace
    from inputs import Inputs
    from test_fresh_pipeline import scan
    calls=[]
    response={'value':{'rentEpoch':2**64-1}}
    class Rpc:
        def call(self,method,params):calls.append(method);return response
    def parse(rpc,*args):
        assert rpc.batch_call('getAccountInfo',[['metadata']])[0]==response
        return [],[]
    db=mongomock.MongoClient(tz_aware=True).test
    s=scan();s['linked_wallets']['solana']='test-wallet'
    for _ in range(2):
        inputs=Inputs(db);inputs.raw={'solana':[]};inputs.rpcs={'solana':Rpc()};inputs.audit=SimpleNamespace(solana_trades=parse)
        assert inputs.extract(s)==[]
    assert calls==['getAccountInfo']
    cached=db.fomo_analysis_edge_rpc_cache.find_one({})
    BSON.encode(cached)  # Exercise the actual BSON constraint, not only mongomock.
