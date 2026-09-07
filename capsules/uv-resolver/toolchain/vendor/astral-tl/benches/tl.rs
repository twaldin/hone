use criterion::*;

// Better real world benchmarks: https://github.com/y21/rust-html-parser-benchmark

const INPUT: &str = r#"
<!doctype html>
<html>
<head>
    <title>Example Domain</title>

    <meta charset="utf-8" />
    <meta http-equiv="Content-type" content="text/html; charset=utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>

<body>
<div>
    <h1>Example Domain</h1>
    <p>This domain is for use in illustrative examples in documents. You may use this
    domain in literature without prior coordination or asking for permission.</p>
    <p><a href="https://www.iana.org/domains/example">More information...</a></p>
</div>
</body>
</html>
"#;

// Real-world PyPI Simple API response for iniconfig package
const PYPI_SIMPLE: &str = r#"<!DOCTYPE html>
<html lang="en">
  <head>
    <meta name="pypi:repository-version" content="1.4">
<meta name="pypi:project-status" content="active">    <title>Links for iniconfig</title>
  </head>
  <body>
    <h1>Links for iniconfig</h1>
<a href="https://files.pythonhosted.org/packages/47/a6/5075a9c302cafbf63435556c70e209a0715eb92de86ea85e55dbb4282899/iniconfig-0.1.tar.gz#sha256=f0a16b26d6439c6cf0841a1d77d8fe93c6bacdeff9e7d45dadf8fc83a2e56ae1" >iniconfig-0.1.tar.gz</a><br />
<a href="https://files.pythonhosted.org/packages/59/af/786e6cf4db2fe22427f7819db46ae194908eed48a9a35f2071a722e3c655/iniconfig-0.2.dev0.tar.gz#sha256=33fd6d8a36c45871e4fd56801d0549002c3c9fdc347cf90cf63b944303b24ad9" >iniconfig-0.2.dev0.tar.gz</a><br />
<a href="https://files.pythonhosted.org/packages/9d/6f/7187ac1996add14e220e565cad9867eb0b90b5fda523357f5ba52ee16d31/iniconfig-1.0.0.tar.gz#sha256=aa0b40f50a00e72323cb5d41302f9c6165728fd764ac8822aa3fff00a40d56b4" >iniconfig-1.0.0.tar.gz</a><br />
<a href="https://files.pythonhosted.org/packages/20/46/d2f4919cc48c39c2cb48b589ca9016aae6bad050b8023667eb86950d3da2/iniconfig-1.0.1-py3-none-any.whl#sha256=80cf40c597eb564e86346103f609d74efce0f6b4d4f30ec8ce9e2c26411ba437" data-dist-info-metadata="sha256=27e5d42c8d881fda1137df4c60acda74d064ccf295136e46cf07e46087c34c00" data-core-metadata="sha256=27e5d42c8d881fda1137df4c60acda74d064ccf295136e46cf07e46087c34c00">iniconfig-1.0.1-py3-none-any.whl</a><br />
<a href="https://files.pythonhosted.org/packages/aa/6e/60dafce419de21f2f3f29319114808cac9f49b6c15117a419737a4ce3813/iniconfig-1.0.1.tar.gz#sha256=e5f92f89355a67de0595932a6c6c02ab4afddc6fcdc0bfc5becd0d60884d3f69" >iniconfig-1.0.1.tar.gz</a><br />
<a href="https://files.pythonhosted.org/packages/44/39/e96292c7f7068e58877f476908c5974dc76c37c623f1fa332fe4ed6dfbec/iniconfig-1.1.0.tar.gz#sha256=150a59361017218f4621a68ea9984772675a7f6e074ff7d02e115152f1804dc6" >iniconfig-1.1.0.tar.gz</a><br />
<a href="https://files.pythonhosted.org/packages/9b/dd/b3c12c6d707058fa947864b67f0c4e0c39ef8610988d7baea9578f3c48f3/iniconfig-1.1.1-py2.py3-none-any.whl#sha256=011e24c64b7f47f6ebd835bb12a743f2fbe9a26d4cecaa7f53bc4f35ee9da8b3" data-dist-info-metadata="sha256=ff8fa814aa515ee66fe6bcdea527295d1c21aba0f3aac81b9c0e59a6031431cb" data-core-metadata="sha256=ff8fa814aa515ee66fe6bcdea527295d1c21aba0f3aac81b9c0e59a6031431cb">iniconfig-1.1.1-py2.py3-none-any.whl</a><br />
<a href="https://files.pythonhosted.org/packages/23/a2/97899f6bd0e873fed3a7e67ae8d3a08b21799430fb4da15cfedf10d6e2c2/iniconfig-1.1.1.tar.gz#sha256=bc3af051d7d14b2ee5ef9969666def0cd1a000e121eaea580d4a313df4b37f32" >iniconfig-1.1.1.tar.gz</a><br />
<a href="https://files.pythonhosted.org/packages/ef/a6/62565a6e1cf69e10f5727360368e451d4b7f58beeac6173dc9db836a5b46/iniconfig-2.0.0-py3-none-any.whl#sha256=b6a85871a79d2e3b22d2d1b94ac2824226a63c6b741c88f7ae975f18b6778374" data-requires-python="&gt;=3.7" data-dist-info-metadata="sha256=d8a7017790c416265c94efabb8ffeaccdef5a9c4cbd2136c0b0e4c08320f37a2" data-core-metadata="sha256=d8a7017790c416265c94efabb8ffeaccdef5a9c4cbd2136c0b0e4c08320f37a2">iniconfig-2.0.0-py3-none-any.whl</a><br />
<a href="https://files.pythonhosted.org/packages/d7/4b/cbd8e699e64a6f16ca3a8220661b5f83792b3017d0f79807cb8708d33913/iniconfig-2.0.0.tar.gz#sha256=2d91e135bf72d31a410b17c16da610a82cb55f6b0477d1a902134b24a455b8b3" data-requires-python="&gt;=3.7" >iniconfig-2.0.0.tar.gz</a><br />
<a href="https://files.pythonhosted.org/packages/2c/e1/e6716421ea10d38022b952c159d5161ca1193197fb744506875fbb87ea7b/iniconfig-2.1.0-py3-none-any.whl#sha256=9deba5723312380e77435581c6bf4935c94cbfab9b1ed33ef8d238ea168eb760" data-requires-python="&gt;=3.8" data-dist-info-metadata="sha256=b92f8473887684c659153adb77fe0418a7310501e743709fc12623cd03e7e5cb" data-core-metadata="sha256=b92f8473887684c659153adb77fe0418a7310501e743709fc12623cd03e7e5cb">iniconfig-2.1.0-py3-none-any.whl</a><br />
<a href="https://files.pythonhosted.org/packages/f2/97/ebf4da567aa6827c909642694d71c9fcf53e5b504f2d96afea02718862f3/iniconfig-2.1.0.tar.gz#sha256=3abbd2e30b36733fee78f9c7f7308f2d0050e88f0087fd25c2645f63c773e1c7" data-requires-python="&gt;=3.8" >iniconfig-2.1.0.tar.gz</a><br />
<a href="https://files.pythonhosted.org/packages/13/71/3970abe530a7a15e406874a30ed6cf1ead266444b4503ebb2f68b4d98f30/iniconfig-2.2.0-py3-none-any.whl#sha256=eeea4a571b616cf2951fbeeda9490863f3d1882a21cf673cd3236545488d6f1e" data-requires-python="&gt;=3.10" data-dist-info-metadata="sha256=90baa19b1d0046fde219307f7dc6332c0fe8eb0a65dafb9326c3d2c51edd7f7a" data-core-metadata="sha256=90baa19b1d0046fde219307f7dc6332c0fe8eb0a65dafb9326c3d2c51edd7f7a" data-provenance="https://pypi.org/integrity/iniconfig/2.2.0/iniconfig-2.2.0-py3-none-any.whl/provenance">iniconfig-2.2.0-py3-none-any.whl</a><br />
<a href="https://files.pythonhosted.org/packages/8e/11/2f7713979d561602e14b8fdd99a0e2e8ff2d901de1041c42a23a4c33f2c3/iniconfig-2.2.0.tar.gz#sha256=1807d2bc2eb4231a5e40e2ecee093fc25fc0eb0e2840f01ea50a1d15380adbff" data-requires-python="&gt;=3.10"  data-provenance="https://pypi.org/integrity/iniconfig/2.2.0/iniconfig-2.2.0.tar.gz/provenance">iniconfig-2.2.0.tar.gz</a><br />
<a href="https://files.pythonhosted.org/packages/cb/b1/3846dd7f199d53cb17f49cba7e651e9ce294d8497c8c150530ed11865bb8/iniconfig-2.3.0-py3-none-any.whl#sha256=f631c04d2c48c52b84d0d0549c99ff3859c98df65b3101406327ecc7d53fbf12" data-requires-python="&gt;=3.10" data-dist-info-metadata="sha256=40d773f84e4e112f495bbf4f1be9cbd2d456c0aeb6ef5311f75d1bf322f2165b" data-core-metadata="sha256=40d773f84e4e112f495bbf4f1be9cbd2d456c0aeb6ef5311f75d1bf322f2165b" data-provenance="https://pypi.org/integrity/iniconfig/2.3.0/iniconfig-2.3.0-py3-none-any.whl/provenance">iniconfig-2.3.0-py3-none-any.whl</a><br />
<a href="https://files.pythonhosted.org/packages/72/34/14ca021ce8e5dfedc35312d08ba8bf51fdd999c576889fc2c24cb97f4f10/iniconfig-2.3.0.tar.gz#sha256=c76315c77db068650d49c5b56314774a7804df16fee4402c1f19d6d15d8c4730" data-requires-python="&gt;=3.10"  data-provenance="https://pypi.org/integrity/iniconfig/2.3.0/iniconfig-2.3.0.tar.gz/provenance">iniconfig-2.3.0.tar.gz</a><br />
</body>
</html>
<!--SERIAL 31878540-->
"#;

pub fn criterion_benchmark(cr: &mut Criterion) {
    cr.bench_function("tl", |b| {
        b.iter(|| {
            let _ = tl::parse(black_box(INPUT), tl::ParserOptions::default());
        });
    });

    cr.bench_function("pypi_simple", |b| {
        b.iter(|| {
            let _ = tl::parse(black_box(PYPI_SIMPLE), tl::ParserOptions::default());
        });
    });
}

criterion_group!(benches, criterion_benchmark);
criterion_main!(benches);
