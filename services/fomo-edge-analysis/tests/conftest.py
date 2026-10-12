from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

# mongomock lacks PyMongo 4.11's optional UpdateOne.sort argument.
import pytest
@pytest.fixture(autouse=True)
def mock_bulk_sort_compat(monkeypatch):
    from mongomock.collection import BulkOperationBuilder
    original=BulkOperationBuilder.add_update
    def compatible(self,*args,sort=None,**kwargs):
        assert sort is None
        return original(self,*args,**kwargs)
    monkeypatch.setattr(BulkOperationBuilder,'add_update',compatible)
