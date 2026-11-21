"""Keep useful assertion basenames without embedding build-machine account paths.
The pinned GCC 7 toolchain predates -ffile-prefix-map. This changes diagnostic
strings only; assertions, source code and the hardware profile stay unchanged.
"""
Import('env')


def portable_filename(env, node):
    if not node.name.endswith(('.c', '.cpp', '.cc')):
        return node
    return env.Object(
        node,
        CPPDEFINES=list(env['CPPDEFINES']) + [('__FILE__', '\\"' + node.name + '\\"')],
        CCFLAGS=list(env['CCFLAGS']) + ['-Wno-builtin-macro-redefined'],
    )


env.AddBuildMiddleware(portable_filename)
