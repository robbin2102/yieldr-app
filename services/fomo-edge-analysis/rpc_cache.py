"""Lossless BSON storage for RPC integers outside Mongo's signed int64 range."""
from bson.binary import Binary

# User-defined BSON binary subtype. JSON-RPC responses contain no binary objects.
INTEGER_SUBTYPE = 128

def encode_rpc(value):
    if isinstance(value, int) and not -(1 << 63) <= value < (1 << 63):
        return Binary(str(value).encode('ascii'), subtype=INTEGER_SUBTYPE)
    if isinstance(value, dict):
        return {key: encode_rpc(item) for key, item in value.items()}
    if isinstance(value, list):
        return [encode_rpc(item) for item in value]
    return value

def decode_rpc(value):
    if isinstance(value, Binary) and value.subtype == INTEGER_SUBTYPE:
        return int(bytes(value).decode('ascii'))
    if isinstance(value, dict):
        return {key: decode_rpc(item) for key, item in value.items()}
    if isinstance(value, list):
        return [decode_rpc(item) for item in value]
    return value
