from dbx_tools.postgres import parse_address, parse_resource_path


def test_parse_address_rejects_empty_and_unknown_values() -> None:
    assert parse_address(None).as_dict() == {}
    assert parse_address("").as_dict() == {}
    assert parse_address("Not An Address").as_dict() == {}


def test_parse_address_reads_postgres_uri() -> None:
    parsed = parse_address(
        "postgresql://me%40example.com@ep.example.com:6432/app%20db?sslmode=require"
    )
    assert parsed.as_dict() == {
        "database": "app db",
        "host": "ep.example.com",
        "port": 6432,
        "ssl_mode": "require",
        "user": "me@example.com",
    }


def test_parse_address_reads_resource_paths() -> None:
    assert parse_address("projects/demo").as_dict() == {"project": "demo"}
    assert parse_address("projects/demo/branches/main").as_dict() == {
        "project": "demo",
        "branch": "main",
    }
    assert parse_address("projects/demo/branches/main/endpoints/ep-1").as_dict() == {
        "project": "demo",
        "branch": "main",
        "endpoint": "projects/demo/branches/main/endpoints/ep-1",
        "endpoint_id": "ep-1",
    }
    assert parse_address("projects/demo/branches/main/databases/databricks-postgres").as_dict() == {
        "project": "demo",
        "branch": "main",
        "database_resource_id": "databricks-postgres",
    }


def test_parse_address_distinguishes_hostname_and_project() -> None:
    assert parse_address("ep-1.database.azuredatabricks.net").as_dict() == {
        "host": "ep-1.database.azuredatabricks.net"
    }
    assert parse_address("dbx-tools-demo").as_dict() == {"project": "dbx-tools-demo"}
    assert parse_resource_path("main").as_dict() == {}
