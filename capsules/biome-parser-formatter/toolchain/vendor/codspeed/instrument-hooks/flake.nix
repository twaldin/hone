{
  description = "CodSpeed instrument hooks development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        commonBuildInputs = with pkgs; [
          just
          zig
          clang
          cmake
          bazelisk
          python3
        ];

      in
      {
        devShells = {
          default = pkgs.mkShell {
            buildInputs = commonBuildInputs;
            shellHook = ''
              echo "Instrument hooks development environment"
            '';
          };

          lsp = pkgs.mkShell {
            buildInputs =
              with pkgs;
              [
                zls
                clang-tools
              ]
              ++ commonBuildInputs;
            shellHook = ''
              echo "Instrument hooks development environment with LSP"
            '';
          };
        };
      }
    );
}
