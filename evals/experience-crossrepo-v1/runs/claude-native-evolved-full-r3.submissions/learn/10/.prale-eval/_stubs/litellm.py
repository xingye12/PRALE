import types
__version__ = "stub"
suppress_debug_info = True
set_verbose = False
drop_params = True
_logging = types.SimpleNamespace(_disable_debugging=lambda: None)
def get_model_info(model):
    raise ValueError("This model isn't mapped yet. Add it to model_prices_and_context_window.json")
