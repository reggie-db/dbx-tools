import json
import os
import sys
import sysconfig

"""Report the active Python runtime paths consumed by the Bun FFI adapter."""


def main() -> None:
    print(
        json.dumps(
            {
                "basePrefix": sys.base_prefix,
                "library": os.path.join(
                    sysconfig.get_config_var("LIBDIR"),
                    sysconfig.get_config_var("LDLIBRARY"),
                ),
                "prefix": sys.prefix,
                "purelib": sysconfig.get_paths()["purelib"],
            }
        )
    )


if __name__ == "__main__":
    main()
