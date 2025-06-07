from setuptools import setup, find_packages

setup(
    name="ctbk",
    use_scm_version=True,
    packages=find_packages(),
    install_requires=open('pip.lock', 'r').read(),
    entry_points={
        'console_scripts': [
            'ctbk = ctbk.cli.main:main',
            'yms = ctbk.cli.yms:yms',
        ]
    }
)
