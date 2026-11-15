"""Live integration tests — hit the real browsa.io API.

Skipped automatically when BROWSA_API_KEY isn't set. Run manually:

    BROWSA_API_KEY=agt_live_... pytest tests/test_live.py -v
"""
import os

import pytest

KEY = os.environ.get("BROWSA_API_KEY")
pytestmark = pytest.mark.skipif(not KEY, reason="set BROWSA_API_KEY to run live tests")


@pytest.fixture
def client():
    from browsa import Client
    return Client(api_key=KEY)


def test_credits_endpoint(client):
    c = client.credits()
    assert isinstance(c, dict)
    assert "balance" in c
    assert isinstance(c["balance"], int)


def test_list_keys(client):
    keys = client.list_keys()
    assert isinstance(keys, list)


def test_list_webhooks(client):
    hooks = client.list_webhooks()
    assert isinstance(hooks, list)


def test_signing_secret(client):
    s = client.get_signing_secret()
    assert isinstance(s, str)
    assert len(s) >= 32  # hex-encoded


def test_invalid_uuid_returns_invalid_id(client):
    from browsa import errors
    with pytest.raises(errors.InvalidIDError) as e:
        client.get_job("not-a-uuid")
    assert e.value.code == "INVALID_ID"
    assert e.value.request_id  # populated by middleware


def test_unknown_uuid_returns_not_found(client):
    from browsa import errors
    with pytest.raises(errors.NotFoundError) as e:
        client.get_job("00000000-0000-0000-0000-000000000000")
    assert e.value.code == "NOT_FOUND"
